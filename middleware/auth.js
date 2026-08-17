import jwt from "jsonwebtoken";

/**
 * Verifies the access token minted by the authenticator service (port 4002).
 *
 * Both services sign/verify with the same HS256 secret (JWT_ACCESS_SECRET), so
 * this check is local — no network call, and this API keeps working even if the
 * authenticator is down. The secret MUST match authenticator-be exactly or every
 * request here 401s.
 *
 * Read the identity from req.user, never from a user_id in the query or body.
 */
export function authenticate(req, res, next) {
  // Read at call time, not import time: server.js loads dotenv after imports.
  const secret = process.env.JWT_ACCESS_SECRET;

  if (!secret) {
    console.error("JWT_ACCESS_SECRET is not set — refusing to authenticate");
    return res.status(500).json({
      success: false,
      message: "Server auth is not configured",
    });
  }

  const [scheme, token] = (req.headers.authorization ?? "").split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  try {
    const payload = jwt.verify(token, secret);

    // The portal will not hand off a session that still owes the forced
    // first-login password change, but a hand-crafted URL could carry one.
    if (payload.must_change_password) {
      return res.status(401).json({
        success: false,
        message: "Password change required",
      });
    }

    req.user = {
      user_id: Number(payload.sub),
      user_name: payload.user_name,
      email_id: payload.email_id,
    };

    return next();
  } catch (error) {
    // The front-end turns any 401 into a bounce back to the authenticator.
    const message =
      error.name === "TokenExpiredError" ? "Session expired" : "Invalid token";

    return res.status(401).json({ success: false, message });
  }
}
