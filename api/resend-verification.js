// POST /api/resend-verification - שליחה מחדש של אימייל האימות
const lib = require('./_lib');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'POST') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const body = await lib.readBody(req);
    const email = String(body.email || '').trim().toLowerCase();

    const r = await lib.q(`SELECT name, verified, verify_sent_at FROM wb_users WHERE email = $1`, [email]);
    if (r.rows.length === 0) {
      return lib.json(res, 404, { message: 'לא נמצא משתמש עם כתובת אימייל זו.' });
    }
    const user = r.rows[0];
    if (user.verified) {
      return lib.json(res, 200, { ok: true, message: 'החשבון כבר אומת. אפשר להתחבר.' });
    }

    // הגבלה: לא יותר מאימייל אחת כל 60 שניות
    if (user.verify_sent_at && (Date.now() - new Date(user.verify_sent_at).getTime()) < 60 * 1000) {
      return lib.json(res, 429, { message: 'קישור האימות נשלח זה עתה. בדוק/י את תיבת הדואר הנכנס (וגם תיקיית ספאם).' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    await lib.q(`UPDATE wb_users SET verify_token = $2, verify_sent_at = NOW() WHERE email = $1`, [email, token]);

    const link = `${lib.getSiteUrl()}/?verify=${token}`;
    await lib.sendMail(email, 'אימות כתובת האימייל - WorkBee 🐝', lib.verificationEmailHtml(user.name, link));

    return lib.json(res, 200, { ok: true, message: 'קישור אימות חדש נשלח לכתובת האימייל שלך.' });
  } catch (err) {
    if (err.message === 'mail-not-configured') {
      return lib.json(res, 500, { message: 'שליחת אימייל אינה מוגדרת עדיין בשרת.' });
    }
    console.error('resend error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת. נסה שוב מאוחר יותר.' });
  }
};
