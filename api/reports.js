// POST /api/reports - דיווח על משתמש:
//   נשמר במסד הנתונים (מופיע בפאנל הניהול #admin)
//   ונשלח באימייל לבעל האתר (OWNER_EMAIL) מיד עם השליחה
const lib = require('./_lib');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'POST') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const me = await lib.getSessionUser(req);
    if (!me) {
      return lib.json(res, 401, { message: 'יש להתחבר כדי לשלוח דיווח.' });
    }

    const body = await lib.readBody(req);
    const category = String(body.category || '');
    const details = String(body.details || '').trim();
    const reportedName = String(body.reportedName || 'משתמש');
    const reportedEmail = String(body.reportedEmail || '').trim().toLowerCase();
    const context = String(body.context || '');

    if (!category) return lib.json(res, 400, { message: 'יש לבחור סיבה לדיווח.' });
    if (details.length < 10) return lib.json(res, 400, { message: 'יש לפרט מה המשתמש עשה (לפחות כמה מילים).' });

    const id = Date.now();
    await lib.q(
      `INSERT INTO wb_reports (id, reported_name, reported_email, reporter_name, reporter_email, category, details, context, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')`,
      [id, reportedName, reportedEmail, me.name, me.email, category, details, context]
    );
    const savedR = await lib.q(`SELECT * FROM wb_reports WHERE id = $1`, [id]);
    const rep = savedR.rows[0];

    // שליחת הדיווח באימייל לבעל האתר
    let emailed = false;
    if (process.env.OWNER_EMAIL) {
      try {
        await lib.sendMail(
          process.env.OWNER_EMAIL,
          '🚩 דיווח חדש על משתמש - WorkBee',
          lib.reportEmailToOwnerHtml(rep)
        );
        emailed = true;
      } catch (mailErr) {
        console.error('report mail error:', mailErr);
      }
    }

    return lib.json(res, 200, {
      ok: true,
      emailed,
      message: emailed
        ? 'הדיווח התקבל ונשלח להנהלת האתר. תודה!'
        : 'הדיווח התקבל ונשמר בפאנל הניהול של האתר. תודה!'
    });
  } catch (err) {
    console.error('reports error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת בשליחת הדיווח.' });
  }
};
