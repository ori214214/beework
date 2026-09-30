// POST /api/login - התחברות (רק לאחר אימות אימייל) + יצירת סשן ל-7 ימים
const lib = require('./_lib');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'POST') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const body = await lib.readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (await lib.isBlockedEmail(email)) {
      return lib.json(res, 403, { code: 'blocked', message: 'החשבון הזה נחסם על ידי הנהלת האתר.' });
    }

    const r = await lib.q(`SELECT email, name, phone, password_hash, verified, verify_sent_at FROM wb_users WHERE email = $1`, [email]);
    if (r.rows.length === 0 || !lib.verifyPassword(password, r.rows[0].password_hash)) {
      return lib.json(res, 401, {
        code: 'bad',
        message: 'לא נמצא משתמש עם פרטים אלו. אם עדיין אין לך חשבון, יש להירשם קודם.'
      });
    }

    const user = r.rows[0];

    if (!user.verified) {
      // שולחים קישור אימות חדש אוטומטית (עם הגבלת תדירות של דקה)
      let resent = false;
      try {
        if (!user.verify_sent_at || (Date.now() - new Date(user.verify_sent_at).getTime()) >= 60 * 1000) {
          const token = require('crypto').randomBytes(24).toString('hex');
          await lib.q(`UPDATE wb_users SET verify_token = $2, verify_sent_at = NOW() WHERE email = $1`, [email, token]);
          const link = `${lib.getSiteUrl()}/?verify=${token}`;
          await lib.sendMail(email, 'אימות כתובת האימייל - WorkBee 🐝', lib.verificationEmailHtml(user.name, link));
          resent = true;
        }
      } catch (mailErr) { /* גם אם המייל נכשל מחזירים שהאימות חסר */ }

      return lib.json(res, 403, {
        code: 'not_verified',
        message: resent
          ? 'עליך לאמת את כתובת האימייל לפני ההתחברות. שלחנו עכשיו קישור אימות חדש לכתובת שלך - יש ללחוץ עליו ואז להתחבר.'
          : 'עליך לאמת את כתובת האימייל לפני ההתחברות. בדוק/י את תיבת הדואר הנכנס - קישור אימות נשלח אליך (כולל תיקיית ספאם).'
      });
    }

    const token = await lib.createSession(email, 'user');
    lib.setCookie(res, 'wb_session', token, lib.SESSION_DAYS * 24 * 60 * 60);

    return lib.json(res, 200, {
      ok: true,
      user: { name: user.name, phone: user.phone, email: user.email }
    });
  } catch (err) {
    console.error('login error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת בהתחברות. נסה שוב מאוחר יותר.' });
  }
};
