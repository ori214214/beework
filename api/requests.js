// POST /api/requests - כל פעולות בקשות העבודה:
//   action=create   שליחת בקשת עבודה למודעה
//   action=respond  אישור/דחיית בקשה (על ידי המעסיק)
//   action=message  שליחת הודעה בצ'אט
//   action=review   אישור סיום עבודה + דירוג וביקורת
const lib = require('./_lib');

async function loadRequest(requestId) {
  const r = await lib.q(`SELECT * FROM wb_requests WHERE id = $1`, [Number(requestId)]);
  return r.rows[0] || null;
}

async function messagesFor(requestId) {
  const r = await lib.q(`SELECT * FROM wb_messages WHERE request_id = $1 ORDER BY ts ASC, id ASC`, [Number(requestId)]);
  return r.rows.map((m) => ({
    sender: m.sender,
    senderEmail: m.sender_email,
    text: m.body,
    ts: Number(m.ts),
    time: m.time_label
  }));
}

function shapeRequest(r, chatMessages) {
  return {
    id: Number(r.id),
    jobId: Number(r.job_id),
    jobTitle: r.job_title,
    applicantName: r.applicant_name,
    applicantEmail: r.applicant_email,
    applicantPhone: r.applicant_phone,
    employerEmail: r.employer_email || '',
    employerName: r.employer_name,
    status: r.status,
    chatMessages: chatMessages || [],
    completion: {
      workerDone: r.worker_done,
      employerDone: r.employer_done,
      workerReview: r.worker_review || null,
      employerReview: r.employer_review || null
    }
  };
}

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'POST') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const me = await lib.getSessionUser(req);
    if (!me) {
      return lib.json(res, 401, { message: 'יש להתחבר כדי לבצע פעולה זו.' });
    }

    const body = await lib.readBody(req);
    const action = String(body.action || '');

    // ---------------- שליחת בקשת עבודה ----------------
    if (action === 'create') {
      const jobId = Number(body.jobId);
      const jobR = await lib.q(`SELECT * FROM wb_jobs WHERE id = $1`, [jobId]);
      if (jobR.rows.length === 0) {
        return lib.json(res, 404, { message: 'המודעה לא נמצאה.' });
      }
      const job = jobR.rows[0];

      const dup = await lib.q(
        `SELECT 1 FROM wb_requests WHERE job_id = $1 AND applicant_email = $2 LIMIT 1`,
        [jobId, me.email]
      );
      if (dup.rows.length > 0) {
        return lib.json(res, 409, {
          code: 'already',
          message: 'כבר שלחת בקשה למודעה זו. ניתן לעקוב אחר הסטטוס באזור האישי.'
        });
      }

      const id = Date.now();
      await lib.q(
        `INSERT INTO wb_requests (id, job_id, job_title, applicant_name, applicant_email, applicant_phone, employer_email, employer_name, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
        [id, job.id, job.title, me.name, me.email, me.phone || '', job.employer_email || '', job.employer || '']
      );
      const created = await loadRequest(id);

      return lib.json(res, 200, { ok: true, request: shapeRequest(created, []) });
    }

    // ---------------- אישור / דחייה ----------------
    if (action === 'respond') {
      const request = await loadRequest(body.requestId);
      if (!request) return lib.json(res, 404, { message: 'הבקשה לא נמצאה.' });
      if (String(request.employer_email || '').toLowerCase() !== String(me.email).toLowerCase()) {
        return lib.json(res, 403, { message: 'רק המעסיק יכול להגיב לבקשה זו.' });
      }
      const decision = body.decision === 'accepted' ? 'accepted' : 'declined';
      await lib.q(`UPDATE wb_requests SET status = $2 WHERE id = $1`, [request.id, decision]);
      const updated = await loadRequest(request.id);
      return lib.json(res, 200, { ok: true, request: shapeRequest(updated, await messagesFor(request.id)) });
    }

    // ---------------- הודעה בצ'אט ----------------
    if (action === 'message') {
      const request = await loadRequest(body.requestId);
      if (!request) return lib.json(res, 404, { message: 'הבקשה לא נמצאה.' });
      const isParty = String(request.employer_email || '').toLowerCase() === String(me.email).toLowerCase()
        || String(request.applicant_email || '').toLowerCase() === String(me.email).toLowerCase();
      if (!isParty) return lib.json(res, 403, { message: 'אין הרשאה לשלוח הודעה בבקשה זו.' });
      if (request.status !== 'accepted') {
        return lib.json(res, 409, { message: 'ניתן לשוחח בצ\u0027אט רק לאחר אישור הבקשה.' });
      }
      const text = String(body.text || '').trim();
      if (!text) return lib.json(res, 400, { message: 'ההודעה ריקה.' });

      await lib.q(
        `INSERT INTO wb_messages (request_id, sender, sender_email, body, ts, time_label)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [request.id, me.name, me.email, text, Date.now(),
         new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })]
      );
      const updated = await loadRequest(request.id);
      return lib.json(res, 200, { ok: true, request: shapeRequest(updated, await messagesFor(request.id)) });
    }

    // ---------------- אישור סיום עבודה + דירוג ----------------
    if (action === 'review') {
      const request = await loadRequest(body.requestId);
      if (!request) return lib.json(res, 404, { message: 'הבקשה לא נמצאה.' });
      if (request.status !== 'accepted') {
        return lib.json(res, 409, { message: 'ניתן לדרג רק בקשות שאושרו.' });
      }

      const role = String(request.employer_email || '').toLowerCase() === String(me.email).toLowerCase()
        ? 'employer'
        : (String(request.applicant_email || '').toLowerCase() === String(me.email).toLowerCase() ? 'worker' : null);
      if (!role) return lib.json(res, 403, { message: 'אין הרשאה לדרג בקשה זו.' });

      const jobR = await lib.q(`SELECT * FROM wb_jobs WHERE id = $1`, [request.job_id]);
      if (jobR.rows.length > 0 && !lib.hasWorkEnded(jobR.rows[0])) {
        return lib.json(res, 409, { message: 'ניתן ללחוץ "העבודה הושלמה" רק לאחר שזמן העבודה הסתיים.' });
      }

      const score = Number(body.score);
      const text = String(body.text || '').trim();
      if (!(score >= 1 && score <= 5)) return lib.json(res, 400, { message: 'יש לבחור ציון (1 עד 5 כוכבים).' });
      if (!text) return lib.json(res, 400, { message: 'יש לכתוב ביקורת.' });

      if (role === 'worker') {
        if (request.worker_done) return lib.json(res, 409, { message: 'כבר אישרת ודירגת בקשה זו.' });
        await lib.q(
          `UPDATE wb_requests SET worker_done = TRUE, worker_review = $2 WHERE id = $1`,
          [request.id, JSON.stringify({ score, text, authorName: me.name, authorEmail: me.email, ts: Date.now() })]
        );
      } else {
        if (request.employer_done) return lib.json(res, 409, { message: 'כבר אישרת ודירגת בקשה זו.' });
        await lib.q(
          `UPDATE wb_requests SET employer_done = TRUE, employer_review = $2 WHERE id = $1`,
          [request.id, JSON.stringify({ score, text, authorName: me.name, authorEmail: me.email, ts: Date.now() })]
        );
      }

      const updated = await loadRequest(request.id);
      const bothDone = updated.worker_done && updated.employer_done;
      return lib.json(res, 200, {
        ok: true,
        bothDone,
        request: shapeRequest(updated, await messagesFor(request.id))
      });
    }

    return lib.json(res, 400, { message: 'פעולה לא מוכרת.' });
  } catch (err) {
    console.error('requests error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת בפעולת הבקשה.' });
  }
};
