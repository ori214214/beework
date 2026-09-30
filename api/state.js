// GET /api/state - כל נתוני האתר ממסד הנתונים המשותף:
//   jobs      = כל המודעות של כל המשתמשים (כולל דירוג מחושב)
//   myRequests= הבקשות שלי (ששלחתי + שהתקבלו אליי) כולל צ'אט וסטטוס השלמה
//   user      = המשתמש המחובר (או null)
const lib = require('./_lib');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'GET') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const me = await lib.getSessionUser(req);
    const blocked = await lib.getBlockedEmails();
    const blockedSet = new Set(blocked);

    // ---- Jobs (public - visible to everyone, newest first) ----
    const jobsR = await lib.q(`SELECT * FROM wb_jobs ORDER BY created_at DESC, id DESC`);
    const jobs = jobsR.rows.filter((j) => !blockedSet.has(String(j.employer_email || '').toLowerCase()));

    // ---- All requests (needed to compute published ratings) ----
    const allReqR = await lib.q(`SELECT * FROM wb_requests`);
    const allRequests = allReqR.rows;
    const jobsById = {};
    jobsR.rows.forEach((j) => { jobsById[j.id] = j; });

    // ---- Live employer rating on job cards (published reviews only) ----
    const reviewsAbout = {}; // employerEmail -> [{score}]
    allRequests.forEach((r) => {
      if (!r.employer_email || !r.worker_review) return;
      const job = jobsById[r.job_id];
      if (!job || !lib.isReviewPublished(r, job)) return;
      const key = String(r.employer_email).toLowerCase();
      if (blockedSet.has(key)) return;
      if (!reviewsAbout[key]) reviewsAbout[key] = [];
      reviewsAbout[key].push({ score: r.worker_review.score });
    });
    jobs.forEach((j) => {
      const list = reviewsAbout[String(j.employer_email || '').toLowerCase()] || [];
      if (list.length) {
        j.rating = lib.averageScore(list);
        j.reviews_count = list.length;
      }
    });

    // ---- Shape jobs exactly like the original front-end expects ----
    const shapedJobs = jobs.map((j) => ({
      id: Number(j.id),
      title: j.title,
      employer: j.employer,
      employerEmail: j.employer_email || '',
      employerPhone: j.employer_phone || '',
      category: j.category,
      location: j.location,
      city: j.city,
      pay: Number(j.pay),
      rating: Number(j.rating),
      reviewsCount: j.reviews_count,
      badge: j.badge,
      time: j.time,
      minAge: j.min_age,
      desc: j.descr,
      hours: j.hours,
      gender: j.gender
    }));

    // ---- My requests (sent by me + received by me) ----
    let myRequests = [];
    if (me) {
      const mine = allRequests.filter((r) =>
        r.applicant_email === me.email || r.employer_email === me.email);
      mine.sort((a, b) => Number(a.id) - Number(b.id)); // same order as the original (push order)

      const msgR = await lib.q(`SELECT * FROM wb_messages ORDER BY ts ASC, id ASC`);
      const msgsByReq = {};
      msgR.rows.forEach((m) => {
        if (!msgsByReq[m.request_id]) msgsByReq[m.request_id] = [];
        msgsByReq[m.request_id].push({
          sender: m.sender,
          senderEmail: m.sender_email,
          text: m.body,
          ts: Number(m.ts),
          time: m.time_label
        });
      });

      myRequests = mine
        .filter((r) => {
          const other = r.applicant_email === me.email ? r.employer_email : r.applicant_email;
          return !blockedSet.has(String(other || '').toLowerCase());
        })
        .map((r) => ({
          id: Number(r.id),
          jobId: Number(r.job_id),
          jobTitle: r.job_title,
          applicantName: r.applicant_name,
          applicantEmail: r.applicant_email,
          applicantPhone: r.applicant_phone,
          employerEmail: r.employer_email || '',
          employerName: r.employer_name,
          status: r.status,
          chatMessages: msgsByReq[r.id] || [],
          completion: {
            workerDone: r.worker_done,
            employerDone: r.employer_done,
            workerReview: r.worker_review || null,
            employerReview: r.employer_review || null
          }
        }));
    }

    // ---- Current user summary (rating / completed / posted) ----
    let user = null;
    if (me) {
      const publishedAboutMe = [];
      allRequests.forEach((r) => {
        const job = jobsById[r.job_id];
        if (!job || !lib.isReviewPublished(r, job)) return;
        if (r.worker_review && r.employer_email === me.email) {
          publishedAboutMe.push({ score: r.worker_review.score });
        }
        if (r.employer_review && r.applicant_email === me.email) {
          publishedAboutMe.push({ score: r.employer_review.score });
        }
      });
      const completedCount = allRequests.filter(
        (r) => r.applicant_email === me.email && r.worker_done && r.employer_done
      ).length;
      const postedCount = jobsR.rows.filter(
        (j) => String(j.employer_email || '').toLowerCase() === String(me.email).toLowerCase()
      ).length;

      user = {
        name: me.name,
        phone: me.phone,
        email: me.email,
        rating: lib.averageScore(publishedAboutMe),
        completedJobsCount: completedCount,
        postedJobsCount: postedCount
      };
    }

    return lib.json(res, 200, { user, jobs: shapedJobs, myRequests });
  } catch (err) {
    console.error('state error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת בטעינת הנתונים.' });
  }
};
