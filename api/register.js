// POST /api/register - הרשמה עם אימות אימייל (החשבון מופעל רק אחרי האימות)
const lib = require('./_lib');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'POST') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const body = await lib.readBody(req);
    const name = String(body.name || '').trim() || 'משתמש חדש';
    const phone = String(body.phone || '').trim() || 'לא צוין';
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!lib.isValidEmail(email)) {
      return lib.json(res, 400, { message: 'כתובת האימייל אינה תקינה.' });
    }
    if (password.length < 4) {
      return lib.json(res, 400, { message: 'הסיסמה קצרה מדי (לפחות 4 תווים).' });
    }
    if (await lib.isBlockedEmail(email)) {
      return lib.json(res, 403, { message: 'כתובת האימייל הזו נחסמה על ידי הנהלת האתר.' });
    }

    const existing = await lib.q(`SELECT email, verified FROM wb_users WHERE email = $1`, [email]);
    if (existing.rows.length > 0 && existing.rows[0].verified) {
      return lib.json(res, 409, {
        code: 'exists',
        message: 'כבר קיים משתמש רשום עם כתובת אימייל זו. יש להתחבר במקום להירשם.'
      });
    }

    const token = require('crypto').randomBytes(24).toString('hex');
    const passwordHash = lib.hashPassword(password);

    if (existing.rows.length > 0) {
      // נרשם בעבר אבל עדיין לא אימת - מעדכנים פרטים ושולחים קישור מחדש
      await lib.q(
        `UPDATE wb_users SET name=$2, phone=$3, password_hash=$4, verify_token=$5, verify_sent_at=NOW() WHERE email=$1`,
        [email, name, phone, passwordHash, token]
      );
    } else {
      await lib.q(
        `INSERT INTO wb_users (email, name, phone, password_hash, verified, verify_token, verify_sent_at)
         VALUES ($1, $2, $3, $4, FALSE, $5, NOW())`,
        [email, name, phone, passwordHash, token]
      );
    }

    const link = `${lib.getSiteUrl()}/?verify=${token}`;
    await lib.sendMail(email, 'אימות כתובת האימייל - WorkBee 🐝', lib.verificationEmailHtml(name, link));

    return lib.json(res, 200, {
      ok: true,
      message: `נרשמת בהצלחה! 🎉 שלחנו קישור אימות לכתובת ${email}. יש ללחוץ על הקישור שבאימייל כדי לאמת את החשבון - ורק אז להתחבר.`
    });
  } catch (err) {
    if (err.message === 'mail-not-configured') {
      return lib.json(res, 500, {
        message: 'שליחת אימיילי האימות אינה מוגדרת עדיין. יש להגדיר את GMAIL_USER ו-GMAIL_APP_PASSWORD בהגדרות השרת (ראה הוראות ההתקנה).'
      });
    }
    console.error('register error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת בהרשמה. נסה שוב מאוחר יותר.' });
  }
};
