// POST /api/jobs  - פרסום מודעה חדשה
// PUT  /api/jobs  - עריכת שכר ושעות עבודה (ננעלת לאחר אישור בקשת עבודה ראשונה)
const lib = require('./_lib');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;

  try {
    await lib.ensureSchema();
    const me = await lib.getSessionUser(req);
    if (!me) {
      return lib.json(res, 401, { message: 'יש להתחבר כדי לבצע פעולה זו.' });
    }

    const body = await lib.readBody(req);

    // ---------------- פרסום מודעה חדשה ----------------
    if (req.method === 'POST') {
      const now = Date.now();
      const job = {
        id: now,
        title: String(body.title || '').trim(),
        employer: me.name,
        employer_email: me.email,
        employer_phone: me.phone || '',
        category: String(body.category || ''),
        location: String(body.location || ''),
        city: String(body.city || ''),
        pay: Number(body.pay) || 0,
        badge: String(body.time || ''),
        time: String(body.time || ''),
        min_age: Number(body.minAge) || 14,
        descr: String(body.desc || ''),
        hours: String(body.hours || ''),
        gender: String(body.gender || '')
      };

      if (!job.title || !job.category || !job.city || !job.pay || !job.hours) {
        return lib.json(res, 400, { message: 'חסרים פרטים במודעה. יש למלא את כל השדות.' });
      }

      await lib.q(
        `INSERT INTO wb_jobs (id, title, employer, employer_email, employer_phone, category, location, city, pay, rating, reviews_count, badge, time, min_age, descr, hours, gender)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5,0,$10,$11,$12,$13,$14,$15)`,
        [job.id, job.title, job.employer, job.employer_email, job.employer_phone, job.category,
         job.location, job.city, job.pay, job.badge, job.time, job.min_age, job.descr, job.hours, job.gender]
      );

      return lib.json(res, 200, {
        ok: true,
        job: {
          id: job.id, title: job.title, employer: job.employer, employerEmail: job.employer_email,
          employerPhone: job.employer_phone, category: job.category, location: job.location,
          city: job.city, pay: job.pay, rating: 5, reviewsCount: 0, badge: job.badge,
          time: job.time, minAge: job.min_age, desc: job.descr, hours: job.hours, gender: job.gender
        }
      });
    }

    // ---------------- עריכת שכר ושעות ----------------
    if (req.method === 'PUT') {
      const jobId = Number(body.id);
      const pay = Number(body.pay);
      const hoursFrom = String(body.hoursFrom || '');
      const hoursTo = String(body.hoursTo || '');

      if (!jobId || !pay || !/^\d{2}:\d{2}$/.test(hoursFrom) || !/^\d{2}:\d{2}$/.test(hoursTo)) {
        return lib.json(res, 400, { message: 'פרטי העריכה אינם תקינים.' });
      }

      const jobR = await lib.q(`SELECT id, employer_email, title FROM wb_jobs WHERE id = $1`, [jobId]);
      if (jobR.rows.length === 0) {
        return lib.json(res, 404, { message: 'המודעה לא נמצאה.' });
      }
      if (String(jobR.rows[0].employer_email || '').toLowerCase() !== String(me.email).toLowerCase()) {
        return lib.json(res, 403, { message: 'אפשר לערוך רק מודעות שפרסמת בעצמך.' });
      }

      // נעילת עריכה: אסור לערוך אחרי שאושרה בקשת עבודה כלשהי למודעה זו
      const approved = await lib.q(
        `SELECT 1 FROM wb_requests WHERE job_id = $1 AND status = 'accepted' LIMIT 1`,
        [jobId]
      );
      if (approved.rows.length > 0) {
        return lib.json(res, 409, {
          code: 'locked',
          message: 'לא ניתן לערוך את המודעה - כבר אושרה בקשת עבודה למודעה זו.'
        });
      }

      const hours = `${hoursFrom} - ${hoursTo}`;
      const updatedR = await lib.q(
        `UPDATE wb_jobs SET pay = $2, hours = $3 WHERE id = $1 RETURNING *`,
        [jobId, pay, hours]
      );
      const j = updatedR.rows[0];

      return lib.json(res, 200, {
        ok: true,
        job: {
          id: Number(j.id), title: j.title, employer: j.employer, employerEmail: j.employer_email,
          employerPhone: j.employer_phone, category: j.category, location: j.location, city: j.city,
          pay: Number(j.pay), rating: Number(j.rating), reviewsCount: j.reviews_count,
          badge: j.badge, time: j.time, minAge: j.min_age, desc: j.descr, hours: j.hours, gender: j.gender
        }
      });
    }

    return lib.json(res, 405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('jobs error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת בפעולת המודעה.' });
  }
};
