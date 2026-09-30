// GET /api/verify?token=... - אימות כתובת האימייל דרך הקישור שנשלח במייל
const lib = require('./_lib');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'GET') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const token = String(req.query.token || '');
    if (!token) {
      return lib.json(res, 400, { message: 'קישור האימות אינו תקף.' });
    }

    const r = await lib.q(`SELECT email FROM wb_users WHERE verify_token = $1 AND verified = FALSE`, [token]);
    if (r.rows.length === 0) {
      return lib.json(res, 400, { message: 'קישור האימות אינו תקף או שהחשבון כבר אומת. נסה להתחבר.' });
    }

    const email = r.rows[0].email;
    await lib.q(
      `UPDATE wb_users SET verified = TRUE, verify_token = NULL, verify_sent_at = NULL WHERE email = $1`,
      [email]
    );

    return lib.json(res, 200, { ok: true, email: email });
  } catch (err) {
    console.error('verify error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת באימות האימייל.' });
  }
};
