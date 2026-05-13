import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';

// ============= تهيئة Firebase =============
const serviceAccount = {
  type: "service_account",
  project_id: "boomb-fa3e7",
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "boomb-fa3e7"
});

const db = admin.firestore();
const app = express();

// ============= إعدادات الأمان =============
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  origin: ['https://sam55na.github.io', 'http://localhost:3000', 'http://localhost:5500', 'https://*.onrender.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============= منع التكرار =============
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, message: { error: 'الرجاء الانتظار دقيقة' }, standardHeaders: true, legacyHeaders: false });
const strictLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'طلبات كثيرة جداً', standardHeaders: true, legacyHeaders: false });

app.use('/api/', generalLimiter);
app.use('/api/user/deposit', strictLimiter);
app.use('/api/user/withdraw', strictLimiter);
app.use('/api/user/register', strictLimiter);
app.use('/api/user/spin-wheel', strictLimiter);
app.use('/api/game/bet', strictLimiter);
app.use('/api/admin/', generalLimiter);

// ============= الثوابت =============
const RESET_PASSWORD = '2613857';
const ADMIN_EMAIL = 'sam55nam@gmail.com';

// ============= مضاعفات لعبة الدرج =============
const STAIRCASE_MULTIPLIERS = [
    { level: 0, multiplier: 0.2 }, { level: 1, multiplier: 0.4 }, { level: 2, multiplier: 0.6 },
    { level: 3, multiplier: 0.8 }, { level: 4, multiplier: 1.0 }, { level: 5, multiplier: 1.3 },
    { level: 6, multiplier: 1.6 }, { level: 7, multiplier: 1.9 }, { level: 8, multiplier: 2.2 },
    { level: 9, multiplier: 3.2 }, { level: 10, multiplier: 4.2 }, { level: 11, multiplier: 5.2 },
    { level: 12, multiplier: 6.2 }, { level: 13, multiplier: 7.2 }, { level: 14, multiplier: 8.2 },
    { level: 15, multiplier: 9.2 }, { level: 16, multiplier: 10.5 }, { level: 17, multiplier: 11.5 },
    { level: 18, multiplier: 12.5 }, { level: 19, multiplier: 13.5 }, { level: 20, multiplier: 14.5 },
    { level: 21, multiplier: 15.5 }, { level: 22, multiplier: 16.5 }, { level: 23, multiplier: 17.5 },
    { level: 24, multiplier: 18.5 }, { level: 25, multiplier: 19.5 }, { level: 26, multiplier: 20.5 },
    { level: 27, multiplier: 22.0 }, { level: 28, multiplier: 25.0 }
];

const AVAILABLE_BETS = [1000, 2000, 5000, 10000, 20000];

// ============= دوال مساعدة =============
async function generateUniqueReferralCode() {
  let uniqueId;
  let isUnique = false;
  let attempts = 0;
  while (!isUnique && attempts < 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    uniqueId = result;
    const existing = await db.collection('users').where('uniqueId', '==', uniqueId).limit(1).get();
    if (existing.empty) isUnique = true;
    attempts++;
  }
  return uniqueId || 'UID' + Date.now().toString().slice(-8);
}

// ============= المصادقة =============
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) { res.status(401).json({ error: 'جلسة غير صالحة' }); }
};

const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'غير مصرح - منطقة المشرف فقط' });
    req.user = decoded;
    next();
  } catch (error) { res.status(401).json({ error: 'جلسة غير صالحة' }); }
};

// ============= إعدادات النظام =============
async function getSettings() {
  try {
    const doc = await db.collection('settings').doc('config').get();
    if (doc.exists) return doc.data();
    const defaultSettings = {
      minDeposit: 1000, minWithdraw: 5000, shamCashEnabled: true, syriatelEnabled: true,
      shamCashUsdEnabled: false, usdToSypRate: 13000, referralCommission: 5, wheelSpinCost: 50,
      shamCashApiKey: '', shamCashPrivateAddress: '', shamCashPublicAddress: '0930000000',
      shamCashUsdApiKey: '', shamCashUsdPrivateAddress: '', shamCashUsdPublicAddress: '',
      syriatelApiKey: '', syriatelPrivateAddress: '', syriatelPublicAddress: '0930000000',
      gameImageUrl: '', siteTheme: 'red', siteName: 'BOOMB', maintenanceMode: false
    };
    await db.collection('settings').doc('config').set(defaultSettings);
    return defaultSettings;
  } catch (error) { return { minDeposit: 1000, minWithdraw: 5000, referralCommission: 5, wheelSpinCost: 50, siteTheme: 'red' }; }
}

// ============= دوال لعبة الدرج (المخازن) =============
function getPoolLevels() { return STAIRCASE_MULTIPLIERS.filter(l => l.multiplier >= 1.0).map(l => l.multiplier); }

async function getChipPool(betAmount) {
  const poolRef = db.collection('game_pools').doc(`chip_${betAmount}`);
  const poolDoc = await poolRef.get();
  if (!poolDoc.exists) {
    const initialPool = { chipAmount: betAmount, levels: {}, createdAt: new Date(), updatedAt: new Date() };
    for (const level of getPoolLevels()) initialPool.levels[level] = { totalAmount: 0, contributionCount: 0 };
    await poolRef.set(initialPool);
    return initialPool;
  }
  return poolDoc.data();
}

async function getFilledPools(betAmount) {
  const pool = await getChipPool(betAmount);
  const filled = [];
  for (const multiplier of getPoolLevels()) {
    if (pool.levels[multiplier]?.totalAmount > 0) filled.push(multiplier);
  }
  return filled.sort((a, b) => a - b);
}

async function distributePartialLoss(betAmount, lostAmount) {
  const poolRef = db.collection('game_pools').doc(`chip_${betAmount}`);
  const pool = await getChipPool(betAmount);
  const eligibleLevels = getPoolLevels();
  if (eligibleLevels.length === 0) return;
  const sharePerLevel = lostAmount / eligibleLevels.length;
  const updates = {};
  for (const multiplier of eligibleLevels) {
    const current = pool.levels[multiplier] || { totalAmount: 0, contributionCount: 0 };
    updates[`levels.${multiplier}.totalAmount`] = (current.totalAmount || 0) + sharePerLevel;
    updates[`levels.${multiplier}.contributionCount`] = (current.contributionCount || 0) + 1;
  }
  updates.updatedAt = new Date();
  await poolRef.update(updates);
}

async function deductFromPool(betAmount, multiplier, amount) {
  const poolRef = db.collection('game_pools').doc(`chip_${betAmount}`);
  const pool = await getChipPool(betAmount);
  const current = pool.levels[multiplier] || { totalAmount: 0 };
  const deducted = Math.min(current.totalAmount, amount);
  await poolRef.update({ [`levels.${multiplier}.totalAmount`]: current.totalAmount - deducted, updatedAt: new Date() });
  return deducted;
}

// ============= خوارزمية تحديد الانفجار (سرية) =============
async function determineExplosionLevel(betAmount, userBalance) {
  const filledPools = await getFilledPools(betAmount);
  
  // إذا وجدت مخازن ممتلئة - فرصة 65% للفوز
  if (filledPools.length > 0 && Math.random() < 0.65) {
    const randomIndex = Math.floor(Math.random() * filledPools.length);
    return STAIRCASE_MULTIPLIERS.find(l => l.multiplier === filledPools[randomIndex]);
  }
  
  // انفجار مبكر (قبل 1.0)
  const lowLevels = STAIRCASE_MULTIPLIERS.filter(l => l.multiplier < 1.0);
  const isLowBalance = userBalance < betAmount * 3;
  
  if (isLowBalance && Math.random() < 0.4) return lowLevels[Math.floor(Math.random() * 2)]; // 0.2 أو 0.4
  const rand = Math.random();
  if (rand < 0.3) return lowLevels[0]; // 0.2
  if (rand < 0.6) return lowLevels[1]; // 0.4
  if (rand < 0.8) return lowLevels[2]; // 0.6
  return lowLevels[3]; // 0.8
}

// ============= تنفيذ جولة لعبة الدرج =============
async function executeGameRound(userId, betAmount) {
  if (!AVAILABLE_BETS.includes(betAmount)) return { success: false, error: 'مبلغ غير صالح' };
  
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  const userData = userDoc.data();
  
  if (!userData) return { success: false, error: 'مستخدم غير موجود' };
  if (userData.isBanned) return { success: false, error: 'حسابك محظور' };
  if ((userData.balance || 0) < betAmount) return { success: false, error: 'الرصيد غير كافٍ' };
  
  await userRef.update({ balance: admin.firestore.FieldValue.increment(-betAmount) });
  
  const explosionData = await determineExplosionLevel(betAmount, userData.balance);
  const explosionMultiplier = explosionData.multiplier;
  let winAmount = 0, refundAmount = 0, isWin = false;
  
  if (explosionMultiplier >= 1.0) {
    isWin = true;
    winAmount = Math.floor(betAmount * explosionMultiplier);
    await userRef.update({ balance: admin.firestore.FieldValue.increment(winAmount) });
    await deductFromPool(betAmount, explosionMultiplier, winAmount);
  } else {
    refundAmount = Math.floor(betAmount * explosionMultiplier);
    const lostAmount = betAmount - refundAmount;
    if (refundAmount > 0) await userRef.update({ balance: admin.firestore.FieldValue.increment(refundAmount) });
    if (lostAmount > 0) await distributePartialLoss(betAmount, lostAmount);
  }
  
  await db.collection('staircase_games').add({
    userId, userEmail: userData.email, userName: userData.name,
    betAmount, explosionMultiplier, isWin, winAmount, refundAmount, timestamp: new Date()
  });
  
  const updatedUser = await userRef.get();
  return {
    success: true,
    result: { betAmount, explosionMultiplier, isWin, winAmount, refundAmount, newBalance: updatedUser.data().balance }
  };
}

// ============= دوال الإحالة والإيداع =============
async function addReferralCommission(userId, depositAmount) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    if (userData?.referredBy) {
      const settings = await getSettings();
      const commissionAmount = (depositAmount * (settings.referralCommission || 5)) / 100;
      if (commissionAmount > 0) {
        await db.collection('users').doc(userData.referredBy).update({
          referralBalance: admin.firestore.FieldValue.increment(commissionAmount),
          referralEarnings: admin.firestore.FieldValue.increment(commissionAmount)
        });
      }
    }
  } catch (error) { console.error('Commission error:', error); }
}

// ============= API التسجيل والملف الشخصي =============
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const { referrerId } = req.body;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) return res.json({ success: true, user: userDoc.data(), isAdmin: email === ADMIN_EMAIL });
    
    const uniqueId = await generateUniqueReferralCode();
    let referredBy = null, referrerName = null;
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        referredBy = refQuery.docs[0].id;
        referrerName = refQuery.docs[0].data().name;
        await refQuery.docs[0].ref.update({ referralBalance: admin.firestore.FieldValue.increment(5), referralEarnings: admin.firestore.FieldValue.increment(5), referrals: admin.firestore.FieldValue.arrayUnion(uid) });
      }
    }
    
    const newUser = { uniqueId, email, name: name || email.split('@')[0], balance: 0, referralBalance: 0, totalDeposited: 0, totalWithdrawn: 0, referralEarnings: 0, referredBy, referredByName: referrerName, referrals: [], createdAt: new Date(), isBanned: false, lastLogin: new Date(), lastSpinTime: null, totalSpins: 0, totalWinnings: 0 };
    await userRef.set(newUser);
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
  } catch (error) { res.status(500).json({ error: 'خطأ في التسجيل' }); }
});

app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({ success: true, user: userDoc.data(), isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) { res.status(500).json({ error: 'خطأ في جلب البيانات' }); }
});

app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const data = userDoc.data();
    let referrerInfo = null;
    if (data?.referredBy) {
      const referrerDoc = await db.collection('users').doc(data.referredBy).get();
      if (referrerDoc.exists) referrerInfo = { name: referrerDoc.data().name, uniqueId: referrerDoc.data().uniqueId };
    }
    const settings = await getSettings();
    res.json({ success: true, stats: { referralCount: data.referrals?.length || 0, referralEarnings: data.referralEarnings || 0, referralBalance: data.referralBalance || 0, balance: data.balance || 0, totalDeposited: data.totalDeposited || 0, totalWithdrawn: data.totalWithdrawn || 0, uniqueId: data.uniqueId, joinDate: data.createdAt, referredBy: data.referredBy, referredByName: data.referredByName, referrerInfo, siteTheme: settings.siteTheme || 'red', totalSpins: data.totalSpins || 0, totalWinnings: data.totalWinnings || 0 } });
  } catch (error) { res.status(500).json({ error: 'خطأ في جلب الإحصائيات' }); }
});

// ============= API الإيداع والسحب =============
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
  const settings = await getSettings();
  const methods = [];
  if (settings.shamCashEnabled && settings.shamCashPublicAddress) methods.push({ id: 'sham_cash', name: 'شام كاش', address: settings.shamCashPublicAddress, currency: 'SYP', icon: '🏦' });
  if (settings.shamCashUsdEnabled && settings.shamCashUsdPublicAddress) methods.push({ id: 'sham_cash_usd', name: 'شام كاش (دولار)', address: settings.shamCashUsdPublicAddress, currency: 'USD', exchangeRate: settings.usdToSypRate || 13000, icon: '💵' });
  if (settings.syriatelEnabled && settings.syriatelPublicAddress) methods.push({ id: 'syriatel_cash', name: 'سيرياتيل كاش', address: settings.syriatelPublicAddress, currency: 'SYP', icon: '📱' });
  res.json({ success: true, settings: { minDeposit: settings.minDeposit, minWithdraw: settings.minWithdraw, methods, gameImageUrl: settings.gameImageUrl || '', usdToSypRate: settings.usdToSypRate || 13000, referralCommission: settings.referralCommission || 5, siteTheme: settings.siteTheme || 'red', wheelSpinCost: settings.wheelSpinCost || 50 } });
});

app.post('/api/user/deposit', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { method, amount, transactionId } = req.body;
    if (!method || !amount || !transactionId) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: 'المبلغ غير صالح' });
    
    const settings = await getSettings();
    let finalAmountSYP = amountNum;
    
    // التحقق من رقم العملية (محاكاة)
    const existing = await db.collection('deposits').where('transactionId', '==', transactionId).limit(1).get();
    if (!existing.empty) return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً' });
    
    if (finalAmountSYP < settings.minDeposit) return res.status(400).json({ error: `الحد الأدنى ${settings.minDeposit} SYP` });
    
    const userRef = db.collection('users').doc(uid);
    await userRef.update({ balance: admin.firestore.FieldValue.increment(finalAmountSYP), totalDeposited: admin.firestore.FieldValue.increment(finalAmountSYP) });
    await db.collection('deposits').add({ userId: uid, method, amount: finalAmountSYP, transactionId, status: 'completed', verifiedAt: new Date() });
    await addReferralCommission(uid, finalAmountSYP);
    
    const updatedUser = await userRef.get();
    res.json({ success: true, message: `تم إيداع ${finalAmountSYP.toLocaleString()} SYP`, newBalance: updatedUser.data().balance });
  } catch (error) { res.status(500).json({ error: 'حدث خطأ داخلي' }); }
});

app.get('/api/user/deposits', requireAuth, async (req, res) => {
  const snapshot = await db.collection('deposits').where('userId', '==', req.user.uid).orderBy('verifiedAt', 'desc').get();
  const deposits = [];
  snapshot.forEach(doc => { const d = doc.data(); deposits.push({ amount: d.amount, method: d.method, transactionId: d.transactionId, verifiedAt: d.verifiedAt?.toDate?.() || new Date(d.verifiedAt) }); });
  res.json({ success: true, deposits });
});

app.post('/api/user/withdraw', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { amount, address, method } = req.body;
    if (!amount || !address) return res.status(400).json({ error: 'المبلغ والعنوان مطلوبان' });
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: 'المبلغ غير صالح' });
    
    const settings = await getSettings();
    if (amountNum < settings.minWithdraw) return res.status(400).json({ error: `الحد الأدنى ${settings.minWithdraw} SYP` });
    
    const userRef = db.collection('users').doc(uid);
    const userData = (await userRef.get()).data();
    if (!userData) return res.status(404).json({ error: 'مستخدم غير موجود' });
    if (userData.isBanned) return res.status(403).json({ error: 'حسابك محظور' });
    if (userData.balance < amountNum) return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    
    await userRef.update({ balance: admin.firestore.FieldValue.increment(-amountNum), totalWithdrawn: admin.firestore.FieldValue.increment(amountNum) });
    await db.collection('withdraw_requests').add({ userId: uid, userEmail: userData.email, userName: userData.name, amount: amountNum, address, method: method || 'sham_cash', status: 'pending', createdAt: new Date() });
    res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP` });
  } catch (error) { res.status(500).json({ error: 'فشل إنشاء طلب السحب' }); }
});

app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
  const snapshot = await db.collection('withdraw_requests').where('userId', '==', req.user.uid).orderBy('createdAt', 'desc').get();
  const requests = [];
  snapshot.forEach(doc => { const d = doc.data(); requests.push({ amount: d.amount, address: d.address, method: d.method, status: d.status, createdAt: d.createdAt?.toDate?.() || new Date(d.createdAt) }); });
  res.json({ success: true, requests });
});

app.post('/api/user/add-referrer', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { referrerCode } = req.body;
    if (!referrerCode) return res.status(400).json({ error: 'كود الإحالة مطلوب' });
    
    const userRef = db.collection('users').doc(uid);
    const userData = (await userRef.get()).data();
    if (userData.referredBy) return res.status(400).json({ error: 'لديك محيل بالفعل' });
    
    const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerCode).limit(1).get();
    if (referrerQuery.empty) return res.status(404).json({ error: 'كود الإحالة غير صحيح' });
    
    const referrerDoc = referrerQuery.docs[0];
    if (referrerDoc.id === uid) return res.status(400).json({ error: 'لا يمكنك إحالة نفسك' });
    
    await userRef.update({ referredBy: referrerDoc.id, referredByName: referrerDoc.data().name });
    await referrerDoc.ref.update({ referralBalance: admin.firestore.FieldValue.increment(5), referralEarnings: admin.firestore.FieldValue.increment(5), referrals: admin.firestore.FieldValue.arrayUnion(uid) });
    res.json({ success: true, message: `تم إضافة المحيل: ${referrerDoc.data().name}` });
  } catch (error) { res.status(500).json({ error: 'حدث خطأ' }); }
});

// ============= API لعبة الدرج =============
app.get('/api/game/bets', requireAuth, async (req, res) => { res.json({ success: true, availableBets: AVAILABLE_BETS }); });

app.post('/api/game/bet', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { betAmount } = req.body;
    const result = await executeGameRound(uid, Number(betAmount));
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (error) { res.status(500).json({ error: 'حدث خطأ أثناء اللعب' }); }
});

app.get('/api/game/history', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('staircase_games').where('userId', '==', req.user.uid).orderBy('timestamp', 'desc').limit(50).get();
    const games = [];
    snapshot.forEach(doc => { const d = doc.data(); games.push({ betAmount: d.betAmount, explosionMultiplier: d.explosionMultiplier, isWin: d.isWin, winAmount: d.winAmount || 0, refundAmount: d.refundAmount || 0, timestamp: d.timestamp?.toDate?.() || new Date(d.timestamp) }); });
    res.json({ success: true, games });
  } catch (error) { res.json({ success: true, games: [] }); }
});

// ============= API عجلة الحظ =============
const WHEEL_SECTORS = [
  { id: 1, name: 'حظ أوفر', type: 'luck', value: 0, probability: 40 }, { id: 2, name: '10 SYP', type: 'balance', value: 10, probability: 10 },
  { id: 3, name: '20 SYP', type: 'balance', value: 20, probability: 5 }, { id: 4, name: '30 SYP', type: 'balance', value: 30, probability: 5 },
  { id: 5, name: 'حظ أوفر', type: 'luck', value: 0, probability: 40 }, { id: 6, name: '10 SYP', type: 'balance', value: 10, probability: 10 },
  { id: 7, name: '20 SYP', type: 'balance', value: 20, probability: 5 }, { id: 8, name: '30 SYP', type: 'balance', value: 30, probability: 5 }
];

function getRandomSector() { let rand = Math.random() * 100, cum = 0; for (const s of WHEEL_SECTORS) { cum += s.probability; if (rand < cum) return s; } return WHEEL_SECTORS[0]; }

app.get('/api/user/wheel-status', requireAuth, async (req, res) => {
  const userData = (await db.collection('users').doc(req.user.uid).get()).data();
  const settings = await getSettings();
  const lastSpin = userData.lastSpinTime?.toDate?.() || userData.lastSpinTime;
  let canSpin = true, remainingSeconds = 0;
  if (lastSpin) { const diff = (new Date() - lastSpin) / 1000; if (diff < 300) { canSpin = false; remainingSeconds = Math.ceil(300 - diff); } }
  res.json({ success: true, canSpin, remainingSeconds, spinCost: settings.wheelSpinCost || 50, referralBalance: userData.referralBalance || 0, hasEnoughBalance: (userData.referralBalance || 0) >= (settings.wheelSpinCost || 50) });
});

app.post('/api/user/spin-wheel', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const userRef = db.collection('users').doc(uid);
    const userData = (await userRef.get()).data();
    const settings = await getSettings();
    const spinCost = settings.wheelSpinCost || 50;
    
    const lastSpin = userData.lastSpinTime?.toDate?.() || userData.lastSpinTime;
    if (lastSpin && (new Date() - lastSpin) / 1000 < 300) return res.status(400).json({ error: 'يجب الانتظار 5 دقائق' });
    if ((userData.referralBalance || 0) < spinCost) return res.status(400).json({ error: `رصيد الإحالات غير كافٍ` });
    
    const sector = getRandomSector();
    let prizeAmount = 0, message = '';
    if (sector.type === 'balance') {
      prizeAmount = sector.value;
      message = `🎉 فزت بـ ${prizeAmount} SYP!`;
      await userRef.update({ balance: admin.firestore.FieldValue.increment(prizeAmount), referralBalance: admin.firestore.FieldValue.increment(-spinCost), lastSpinTime: new Date(), totalSpins: admin.firestore.FieldValue.increment(1), totalWinnings: admin.firestore.FieldValue.increment(prizeAmount) });
    } else {
      message = `😅 حظ أوفر!`;
      await userRef.update({ referralBalance: admin.firestore.FieldValue.increment(-spinCost), lastSpinTime: new Date(), totalSpins: admin.firestore.FieldValue.increment(1) });
    }
    await db.collection('wheel_spins').add({ userId: uid, sectorName: sector.name, prizeAmount, spinCost, timestamp: new Date() });
    const updated = (await userRef.get()).data();
    res.json({ success: true, sector: sector.id, sectorName: sector.name, prizeAmount, message, newBalance: updated.balance, newReferralBalance: updated.referralBalance });
  } catch (error) { res.status(500).json({ error: 'حدث خطأ' }); }
});

app.get('/api/user/wheel-history', requireAuth, async (req, res) => {
  const snapshot = await db.collection('wheel_spins').where('userId', '==', req.user.uid).orderBy('timestamp', 'desc').limit(50).get();
  const spins = []; snapshot.forEach(doc => { const d = doc.data(); spins.push({ sectorName: d.sectorName, prizeAmount: d.prizeAmount, spinCost: d.spinCost, timestamp: d.timestamp?.toDate?.() || new Date(d.timestamp) }); });
  res.json({ success: true, spins });
});

// ============= API الأدمن الكاملة =============
app.get('/api/admin/settings', requireAdmin, async (req, res) => { res.json({ success: true, settings: await getSettings() }); });
app.post('/api/admin/settings', requireAdmin, async (req, res) => { await db.collection('settings').doc('config').update(req.body); res.json({ success: true }); });
app.post('/api/admin/update-theme', requireAdmin, async (req, res) => { await db.collection('settings').doc('config').update({ siteTheme: req.body.theme }); res.json({ success: true }); });
app.get('/api/site-theme', async (req, res) => { res.json({ success: true, theme: (await getSettings()).siteTheme || 'red' }); });

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const usersSnapshot = await db.collection('users').get();
  const users = []; usersSnapshot.forEach(d => users.push(d.data()));
  const pendingSnapshot = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
  const wheelSpins = await db.collection('wheel_spins').get();
  const games = await db.collection('staircase_games').get();
  let gameBets = 0, gamePayouts = 0;
  games.forEach(d => { gameBets += d.data().betAmount; if (d.data().isWin) gamePayouts += d.data().winAmount; });
  res.json({ success: true, stats: { totalUsers: usersSnapshot.size, totalBalance: users.reduce((s, u) => s + (u.balance || 0), 0), totalDeposited: users.reduce((s, u) => s + (u.totalDeposited || 0), 0), totalWithdrawn: users.reduce((s, u) => s + (u.totalWithdrawn || 0), 0), pendingWithdrawals: pendingSnapshot.size, totalSpins: wheelSpins.size, totalWinnings: wheelSpins.docs.reduce((s, d) => s + (d.data().prizeAmount || 0), 0), totalGames: games.size, totalGameBets: gameBets, totalGamePayouts: gamePayouts } });
});

app.get('/api/admin/withdraw-requests', requireAdmin, async (req, res) => {
  const snapshot = await db.collection('withdraw_requests').orderBy('createdAt', 'desc').get();
  const requests = [];
  for (const doc of snapshot.docs) {
    const d = doc.data();
    const user = await db.collection('users').doc(d.userId).get();
    requests.push({ id: doc.id, userName: user.exists ? user.data().name : null, amount: d.amount, address: d.address, status: d.status, createdAt: d.createdAt?.toDate?.() || new Date(d.createdAt) });
  }
  res.json({ success: true, requests });
});

app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
  const { requestId, action } = req.body;
  const requestDoc = await db.collection('withdraw_requests').doc(requestId).get();
  if (!requestDoc.exists) return res.status(404).json({ error: 'طلب غير موجود' });
  const request = requestDoc.data();
  if (request.status !== 'pending') return res.status(400).json({ error: 'تم معالجة هذا الطلب' });
  if (action === 'reject') await db.collection('users').doc(request.userId).update({ balance: admin.firestore.FieldValue.increment(request.amount) });
  await db.collection('withdraw_requests').doc(requestId).update({ status: action === 'approve' ? 'approved' : 'rejected', processedAt: new Date() });
  res.json({ success: true });
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  const snapshot = await db.collection('deposits').orderBy('verifiedAt', 'desc').limit(100).get();
  const deposits = [];
  for (const doc of snapshot.docs) {
    const d = doc.data();
    const user = await db.collection('users').doc(d.userId).get();
    deposits.push({ userName: user.exists ? user.data().name : null, amount: d.amount, method: d.method, transactionId: d.transactionId, verifiedAt: d.verifiedAt?.toDate?.() || new Date(d.verifiedAt) });
  }
  res.json({ success: true, deposits });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const snapshot = await db.collection('users').orderBy('createdAt', 'desc').get();
  const users = [];
  snapshot.forEach(doc => {
    const d = doc.data();
    users.push({ id: doc.id, email: d.email, name: d.name, uniqueId: d.uniqueId, balance: d.balance, referralBalance: d.referralBalance || 0, isBanned: d.isBanned || false, referredByName: d.referredByName, referralsCount: d.referrals?.length || 0, totalSpins: d.totalSpins || 0, totalWinnings: d.totalWinnings || 0 });
  });
  res.json({ success: true, users });
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  await db.collection('users').doc(req.body.userId).update({ balance: admin.firestore.FieldValue.increment(Number(req.body.amount)) });
  res.json({ success: true });
});

app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  const userDoc = await db.collection('users').doc(req.body.userId).get();
  const currentBan = userDoc.data()?.isBanned || false;
  await db.collection('users').doc(req.body.userId).update({ isBanned: !currentBan });
  res.json({ success: true, isBanned: !currentBan });
});

app.post('/api/admin/update-wheel-cost', requireAdmin, async (req, res) => {
  await db.collection('settings').doc('config').update({ wheelSpinCost: req.body.cost });
  res.json({ success: true });
});

app.get('/api/admin/game-pools', requireAdmin, async (req, res) => {
  const pools = {};
  for (const bet of AVAILABLE_BETS) pools[bet] = (await getChipPool(bet)).levels;
  res.json({ success: true, pools });
});

app.post('/api/admin/add-to-pool', requireAdmin, async (req, res) => {
  const { chipAmount, multiplier, amount } = req.body;
  const poolRef = db.collection('game_pools').doc(`chip_${chipAmount}`);
  const pool = await getChipPool(chipAmount);
  await poolRef.update({ [`levels.${multiplier}.totalAmount`]: (pool.levels[multiplier]?.totalAmount || 0) + amount, updatedAt: new Date() });
  res.json({ success: true });
});

app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
  if (req.body.password !== RESET_PASSWORD) return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
  const collections = ['users', 'withdraw_requests', 'deposits', 'referral_commissions', 'wheel_spins', 'staircase_games', 'game_pools'];
  for (const col of collections) { const snapshot = await db.collection(col).get(); for (const doc of snapshot.docs) await db.collection(col).doc(doc.id).delete(); }
  await db.collection('settings').doc('config').set({ minDeposit: 1000, minWithdraw: 5000, shamCashEnabled: true, syriatelEnabled: true, shamCashUsdEnabled: false, usdToSypRate: 13000, referralCommission: 5, wheelSpinCost: 50, siteTheme: 'red' });
  res.json({ success: true, message: 'تم تهيئة قاعدة البيانات' });
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🎲 Staircase Game: ${AVAILABLE_BETS.length} chips, ${STAIRCASE_MULTIPLIERS.length} levels`);
  console.log(`💰 Pool system: multipliers >= 1.0x only`);
});
