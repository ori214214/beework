// POST /api/logout - התנתקות (מוחק את הסשן; החשבון עצמו נשאר שמור)
const lib = require('./_lib');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'POST') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    await lib.destroySession(req, res, 'wb_session', 'user');
    return lib.json(res, 200, { ok: true });
  } catch (err) {
    console.error('logout error:', err);
    return lib.json(res, 500, { message: 'שגיאת שרת.' });
  }
};
