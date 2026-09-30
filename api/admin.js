// POST /api/admin - פאנל הניהול (#admin):
//   action=login          כניסת מנהל עם סיסמה (ADMIN_PASSWORD)
//   action=state          דיווחים + משתמשים + חסומים + סטטיסטיקות
//   action=block          חסימה / ביטול חסימה של אימייל
//   action=delete         מחיקת משתמש לצמיתות (כולל המודעות והבקשות שלו)
//   action=report-status  סימון דיווח כטופל / פתיחה מחדש
//   action=logout         יציאה מפאנל הניהול
const lib = require('./_lib');

async function adminState() {
  const repR = await lib.q(`SELECT * FROM wb_reports ORDER BY created_at DESC, id DESC`);
  const usersR = await lib.q(`SELECT name, phone, email, verified, created_at FROM wb_users ORDER BY created_at DESC`);
  const blocked = await lib.getBlockedEmails();
  return {
    stats: {
      openReports: repR.rows.filter((x) => x.status === 'open').length,
      totalReports: repR.rows.length,
      users: usersR.rows.length,
      blocked: blocked.length
    },
    reports: repR.rows.map((x) => ({
      id: Number(x.id),
      createdAt: x.created_at,
      reportedName: x.reported_name,
      reportedEmail: x.reported_email,
      reporterName: x.reporter_name,
      reporterEmail: x.reporter_email,
      category: x.category,
      details: x.details,
      context: x.context,
      status: x.status
    })),
    users: usersR.rows.map((u) => ({
      name: u.name, phone: u.phone, email: u.email,
      verified: u.verified, createdAt: u.created_at
    })),
    blocked
  };
}

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'POST') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const body = await lib.readBody(req);
    const action = String(body.action || '');

    // ---------------- כניסת מנהל ----------------
    if (action === 'login') {
      const adminPass = process.env.ADMIN_PASSWORD || '';
      if (!adminPass) {
        return lib.json(res, 500, {
          message: 'לא הוגדרה סיסמת מנהל. יש להגדיר את ADMIN_PASSWORD בהגדרות השרת ב-Vercel (ראה הוראות ההתקנה).'
        });
      }
      if (!lib.safeEqual(body.password, adminPass)) {
        return lib.json(res, 401, { message: 'סיסמה שגויה.' });
      }
      const token = await lib.createSession('__admin__', 'admin');
      lib.setCookie(res, 'wb_admin', token, 12 * 60 * 60);
      return lib.json(res, 200, { ok: true });
    }

    // ---------------- כל השאר דורש הרשאת מנהל ----------------
    if (!(await lib.isAdminSession(req))) {
      return lib.json(res, 401, { message: 'נדרשת כניסת מנהל.' });
    }

    if (action === 'state') {
      return lib.json(res, 200, { ok: true, ...(await adminState()) });
    }

    if (action === 'logout') {
      await lib.destroySession(req, res, 'wb_admin', 'admin');
      return lib.json(res, 200, { ok: true });
    }

    if (action === 'block') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return lib.json(res, 400, { message: 'כתובת אימייל חסרה.' });
      if (body.blocked) {
        await lib.q(`INSERT INTO wb_blocked (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
      } else {
        await lib.q(`DELETE FROM wb_blocked WHERE email = $1`, [email]);
      }
      return lib.json(res, 200, { ok: true, blocked: (await adminState()).blocked });
    }

    if (action === 'report-status') {
      const id = Number(body.id);
      const r = await lib.q(`SELECT status FROM wb_reports WHERE id = $1`, [id]);
      if (r.rows.length === 0) return lib.json(res, 404, { message: 'הדיווח לא נמצא.' });
      const newStatus = r.rows[0].status === 'open' ? 'handled' : 'open';
      const updated = await lib.q(
        `UPDATE wb_reports SET status = $2 WHERE id = $1 RETURNING *`,
        [id, newStatus]
      );
      const x = updated.rows[0];
      return lib.json(res, 200, {
        ok: true,
        report: {
          id: Number(x.id), createdAt: x.created_at, reportedName: x.reported_name,
          reportedEmail: x.reported_email, reporterName: x.reporter_name,
          reporterEmail: x.reporter_email, category: x.category, details: x.details,
          context: x.context, status: x.status
        }
      });
    }

    if (action === 'delete') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return lib.json(res, 400, { message: 'כתובת אימייל חסרה.' });

      // מוחקים את המשתמש, המודעות, הבקשות (שניהם הצדדים), ההודעות והסשנים שלו
      await lib.q(
        `DELETE FROM wb_messages WHERE request_id IN (
           SELECT id FROM wb_requests WHERE applicant_email = $1 OR employer_email = $1
         )`,
        [email]
      );
      await lib.q(`DELETE FROM wb_requests WHERE applicant_email = $1 OR employer_email = $1`, [email]);
      await lib.q(`DELETE FROM wb_jobs WHERE employer_email = $1`, [email]);
      await lib.q(`DELETE FROM wb_sessions WHERE email = $1`, [email]);
      const del = await lib.q(`DELETE FROM wb_users WHERE email = $1`, [email]);
      if (del.rowCount === 0) return lib.json(res, 404, { message: 'המשתמש לא נמצא.' });

      return lib.json(res, 200, { ok: true, ...(await adminState()) });
    }

    return lib.json(res, 400, { message: 'פעולה לא מוכרת.' });
  } catch (err) {
    console.error('admin error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת בפאנל הניהול.' });
  }
};
