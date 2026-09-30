// GET /api/session - בדיקת התחברות אוטומטית (עד 7 ימים מהביקור האחרון)
const lib = require('./_lib');

module.exports = async (req, res) => {
  if (lib.applyCors(req, res)) return;
  if (req.method !== 'GET') return lib.json(res, 405, { message: 'Method not allowed' });

  try {
    await lib.ensureSchema();
    const user = await lib.getSessionUser(req);
    if (!user) return lib.json(res, 200, { user: null });
    return lib.json(res, 200, {
      user: { name: user.name, phone: user.phone, email: user.email }
    });
  } catch (err) {
    console.error('session error:', err);
    return lib.json(res, 200, { user: null });
  }
};
