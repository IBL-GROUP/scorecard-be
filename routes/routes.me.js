import express from "express";

import db from "../models/index.js";

/**
 * GET /api/me — who the caller is and what they are entitled to.
 *
 * This dashboard has no login and no access model of its own: it holds a token
 * the authenticator minted, and that token carries nothing but an id. Everything
 * a screen needs beyond that — the person behind the login, their employee
 * record and organization, the roles they hold and the permission codes those
 * roles grant — is read here, live.
 *
 * Deliberately NOT baked into the JWT. A token is fixed once minted, so a role
 * revoked this morning would keep working until the holder happened to sign in
 * again; and one ordinary user already holds enough permission codes to make an
 * unwieldy Authorization header. Reading it per request means an access change
 * takes effect on the next page load.
 *
 * The grant chain, in full:
 *
 *   user_login -> application_user -> user_role_assignment -> app_role
 *              -> role_permission  -> permission
 *
 * Every hop is filtered on being active, so an inactive role or a retired
 * permission stops granting without anyone having to tear its links down.
 */
const router = express.Router();

const select = (sql, replacements) =>
  db.sequelize.query(sql, {
    type: db.sequelize.QueryTypes.SELECT,
    replacements,
  });

/**
 * The identity behind the token. Every join is LEFT: a login can exist before it
 * is granted an application_user, and an external user has no employee row — in
 * both cases the caller should still get back who they are rather than a 404.
 *
 * person and employee are reached through application_user where it exists and
 * through user_login otherwise, because the two carry the links independently
 * and only one of them is guaranteed to be filled in.
 */
const IDENTITY_SQL = `
  SELECT ul.user_login_id, ul.user_name, ul.email_id, ul.display_name,
         ul.record_status, ul.account_locked, ul.last_login_date,
         ul.password_last_changed,
         au.application_user_id, au.login_name, au.user_type, au.user_status,
         au.authentication_source, au.last_login_at,
         p.person_id, p.first_name, p.last_name, p.mobile_no,
         p.email AS person_email, p.status_code,
         e.employee_id, e.employee_code, e.employment_status,
         e.joining_date,
         o.organization_id, o.organization_code, o.organization_name
    FROM organization.user_login ul
    LEFT JOIN organization.application_user au
           ON au.application_user_id = ul.application_user_id
    LEFT JOIN organization.person p
           ON p.person_id = COALESCE(au.person_id, ul.person_id)
    LEFT JOIN organization.employee e
           ON e.employee_id = COALESCE(au.employee_id, ul.employee_id)
    LEFT JOIN organization.organization o
           ON o.organization_id = COALESCE(e.home_organization_id,
                                           au.default_organization_id)
   WHERE ul.user_login_id = :userLoginId
   LIMIT 1
`;

/** Roles and permissions both hang off application_user, never off person. */
const ASSIGNED_ROLES = `
    FROM organization.user_role_assignment ura
    JOIN organization.app_role r
         ON r.role_id = ura.role_id
        AND r.is_active
`;

/** Kept apart from the joins above so the permission query can add its own. */
const HELD_BY_CALLER = `
   WHERE ura.application_user_id = :applicationUserId
     AND ura.assignment_status = 'ACTIVE'
`;

const ROLES_SQL = `
  SELECT DISTINCT r.role_id, r.role_code, r.role_name, r.role_category,
         r.channel_access, r.is_system_role
  ${ASSIGNED_ROLES}
  ${HELD_BY_CALLER}
   ORDER BY r.role_name
`;

const PERMISSIONS_SQL = `
  SELECT DISTINCT p.permission_code, p.permission_name, p.project_code,
         p.module_code, p.resource_code, p.section_code, p.section_name,
         p.action_code, p.sensitivity_level
  ${ASSIGNED_ROLES}
    JOIN organization.role_permission rp
         ON rp.role_id = r.role_id
        AND rp.access_decision = 'ALLOW'
    JOIN organization.permission p
         ON p.permission_id = rp.permission_id
        AND p.is_active
  ${HELD_BY_CALLER}
   ORDER BY p.permission_code
`;

router.get("/", async (req, res) => {
  try {
    const userLoginId = req.user?.user_id;
    if (!userLoginId) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    }

    const [identity] = await select(IDENTITY_SQL, { userLoginId });
    if (!identity) {
      // The token verified, but the login it names is gone — treat it as a dead
      // session rather than a server fault, so the client bounces to sign-in.
      return res
        .status(401)
        .json({ success: false, message: "This session's user no longer exists" });
    }

    const applicationUserId = identity.application_user_id;

    // Someone with no application_user holds no roles by definition, and asking
    // for them would mean a query with a NULL parameter that can never match.
    const [roles, granted] = applicationUserId
      ? await Promise.all([
          select(ROLES_SQL, { applicationUserId }),
          select(PERMISSIONS_SQL, { applicationUserId }),
        ])
      : [[], []];

    return res.json({
      success: true,
      data: {
        user: {
          user_login_id: identity.user_login_id,
          user_name: identity.user_name,
          // The login's address is the authoritative one; the person's is the
          // fallback for accounts created before logins carried an email.
          email: identity.email_id ?? identity.person_email,
          display_name:
            identity.display_name ||
            [identity.first_name, identity.last_name]
              .filter((part) => part && part !== "-")
              .join(" ") ||
            identity.user_name,
          first_name: identity.first_name,
          last_name: identity.last_name,
          mobile_no: identity.mobile_no,
          status_code: identity.status_code ?? identity.record_status,
          account_locked: identity.account_locked,
          last_login_at: identity.last_login_at ?? identity.last_login_date,
          password_last_changed: identity.password_last_changed,

          // The ids the rest of the access model is keyed on. Anything writing
          // an assignment needs application_user_id, not user_login_id.
          application_user_id: identity.application_user_id,
          person_id: identity.person_id,
          employee_id: identity.employee_id,

          employee_code: identity.employee_code,
          employment_status: identity.employment_status,
          joining_date: identity.joining_date,
          user_type: identity.user_type,
          user_status: identity.user_status,
          authentication_source: identity.authentication_source,
          // An employee with no employee row is an external user — that absence
          // is the distinction, so it is worth stating rather than inferring.
          is_employee: Boolean(identity.employee_id),
        },
        organization: identity.organization_id
          ? {
              organization_id: identity.organization_id,
              organization_code: identity.organization_code,
              organization_name: identity.organization_name,
            }
          : null,
        roles,
        role_codes: roles.map((role) => role.role_code),
        // The flat list is what a client actually checks against; `granted`
        // keeps the parts already split out, so nothing has to pull a dotted
        // code back apart to find its section or action.
        permissions: granted.map((row) => row.permission_code),
        granted,
      },
    });
  } catch (error) {
    console.error("Error fetching the current user:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching the current user",
      error: error.message,
    });
  }
});

export default router;
