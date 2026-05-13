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
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

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
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'الرجاء الانتظار دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'طلبات كثيرة جداً، الرجاء الانتظار' },
  standardHeaders: true,
  legacyHeaders: false
});

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

// ============= ثوابت لعبة الدرج =============
const STAIRCASE_MULTIPLIERS = [
    { level: 0, multiplier: 0.2 },
    { level: 1, multiplier: 0.4 },
    { level: 2, multiplier: 0.6 },
    { level: 3, multiplier: 0.8 },
    { level: 4, multiplier: 1.0 },
    { level: 5, multiplier: 1.3 },
    { level: 6, multiplier: 1.6 },
    { level: 7, multiplier: 1.9 },
    { level: 8, multiplier: 2.2 },
    { level: 9, multiplier: 3.2 },
    { level: 10, multiplier: 4.2 },
    { level: 11, multiplier: 5.2 },
    { level: 12, multiplier: 6.2 },
    { level: 13, multiplier: 7.2 },
    { level: 14, multiplier: 8.2 },
    { level: 15, multiplier: 9.2 },
    { level: 16, multiplier: 10.5 },
    { level: 17, multiplier: 11.5 },
    { level: 18, multiplier: 12.5 },
    { level: 19, multiplier: 13.5 },
    { level: 20, multiplier: 14.5 },
    { level: 21, multiplier: 15.5 },
    { level: 22, multiplier: 16.5 },
    { level: 23, multiplier: 17.5 },
    { level: 24, multiplier: 18.5 },
    { level: 25, multiplier: 19.5 },
    { level: 26, multiplier: 20.5 },
    { level: 27, multiplier: 22.0 },
    { level: 28, multiplier: 25.0 }
];

const AVAILABLE_BETS = [1000, 2000, 5000, 10000, 20000];

// ============= دالة إنشاء كود فريد =============
async function generateUniqueReferralCode() {
  let uniqueId;
  let isUnique = false;
  let attempts = 0;
  
  while (!isUnique && attempts < 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    uniqueId = result;
    
    const existing = await db.collection('users').where('uniqueId', '==', uniqueId).limit(1).get();
    if (existing.empty) {
      isUnique = true;
    }
    attempts++;
  }
  
  return uniqueId || 'UID' + Date.now().toString().slice(-8);
}

// ============= المصادقة =============
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'غير مصرح - هذه المنطقة للمشرف فقط' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

// ============= إعدادات النظام =============
async function getSettings() {
  try {
    const doc = await db.collection('settings').doc('config').get();
    if (doc.exists) return doc.data();
    
    const defaultSettings = {
      minDeposit: 1000,
      minWithdraw: 5000,
      shamCashEnabled: true,
      syriatelEnabled: true,
      shamCashUsdEnabled: false,
      usdToSypRate: 13000,
      referralCommission: 5,
      wheelSpinCost: 50,
      shamCashApiKey: '',
      shamCashPrivateAddress: '',
      shamCashPublicAddress: '0930000000',
      shamCashUsdApiKey: '',
      shamCashUsdPrivateAddress: '',
      shamCashUsdPublicAddress: '',
      syriatelApiKey: '',
      syriatelPrivateAddress: '',
      syriatelPublicAddress: '0930000000',
      gameImageUrl: '',
      siteTheme: 'red',
      siteName: 'BOOMB',
      maintenanceMode: false
    };
    await db.collection('settings').doc('config').set(defaultSettings);
    return defaultSettings;
  } catch (error) {
    console.error('Error getting settings:', error);
    return {
      minDeposit: 1000,
      minWithdraw: 5000,
      shamCashEnabled: true,
      syriatelEnabled: true,
      shamCashUsdEnabled: false,
      usdToSypRate: 13000,
      referralCommission: 5,
      wheelSpinCost: 50,
      shamCashApiKey: '',
      shamCashPrivateAddress: '',
      shamCashPublicAddress: '0930000000',
      shamCashUsdApiKey: '',
      shamCashUsdPrivateAddress: '',
      shamCashUsdPublicAddress: '',
      syriatelApiKey: '',
      syriatelPrivateAddress: '',
      syriatelPublicAddress: '0930000000',
      gameImageUrl: '',
      siteTheme: 'red',
      siteName: 'BOOMB',
      maintenanceMode: false
    };
  }
}

// ============= كلاس شام كاش =============
class ShamCashClient {
  constructor(apiKey, accountAddress) {
    this.apiKey = apiKey;
    this.accountAddress = accountAddress;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null, expectedCurrency = null) {
    try {
      const params = {
        resource: "shamcash",
        action: "logs",
        account_address: this.accountAddress,
        api_key: this.apiKey
      };
      const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
      
      if (response.status === 200 && response.data.success) {
        const items = response.data.data?.items || [];
        for (const item of items) {
          if (String(item.tran_id) === String(txid)) {
            const apiAmount = parseFloat(item.amount);
            const apiCurrency = item.currency || 'SYP';
            const timestamp = item.created_at || Date.now() / 1000;
            
            if ((Date.now() / 1000 - timestamp) > 86400) {
              return { success: false, message: "العملية أقدم من 24 ساعة" };
            }
            
            if (expectedCurrency && apiCurrency !== expectedCurrency) {
              return { success: false, message: `نوع العملة غير متطابق: ${apiCurrency}` };
            }
            
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: ${apiAmount}` };
            }
            
            return { success: true, amount: apiAmount, currency: apiCurrency };
          }
        }
        return { success: false, message: "رقم العملية غير موجود" };
      }
      return { success: false, message: "فشل التحقق من العملية" };
    } catch (error) {
      console.error('ShamCash error:', error.message);
      return { success: false, message: "خطأ في الاتصال بخدمة شام كاش" };
    }
  }
}

class ShamCashUsdClient {
  constructor(apiKey, accountAddress) {
    this.apiKey = apiKey;
    this.accountAddress = accountAddress;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null) {
    try {
      const params = {
        resource: "shamcash",
        action: "logs",
        account_address: this.accountAddress,
        api_key: this.apiKey
      };
      const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
      
      if (response.status === 200 && response.data.success) {
        const items = response.data.data?.items || [];
        for (const item of items) {
          if (String(item.tran_id) === String(txid)) {
            const apiAmount = parseFloat(item.amount);
            const apiCurrency = item.currency || 'USD';
            const timestamp = item.created_at || Date.now() / 1000;
            
            if ((Date.now() / 1000 - timestamp) > 86400) {
              return { success: false, message: "العملية أقدم من 24 ساعة" };
            }
            
            if (apiCurrency !== 'USD') {
              return { success: false, message: `يجب أن تكون العملية بالدولار، وجدت ${apiCurrency}` };
            }
            
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: ${apiAmount} USD` };
            }
            
            return { success: true, amount: apiAmount, currency: apiCurrency };
          }
        }
        return { success: false, message: "رقم العملية غير موجود" };
      }
      return { success: false, message: "فشل التحقق من العملية" };
    } catch (error) {
      console.error('ShamCash USD error:', error.message);
      return { success: false, message: "خطأ في الاتصال بخدمة شام كاش" };
    }
  }
}

class SyriatelCashClient {
  constructor(apiKey, gsmNumbers) {
    this.apiKey = apiKey;
    this.gsmNumbers = gsmNumbers;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null) {
    for (const gsm of this.gsmNumbers) {
      try {
        const params = {
          api_key: this.apiKey,
          resource: "syriatel",
          action: "find_tx",
          tx: txid,
          gsm: gsm
        };
        const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
        
        if (response.status === 200 && response.data.success && response.data.data?.found) {
          const transaction = response.data.data.transaction || {};
          const apiAmount = parseFloat(transaction.amount || 0);
          if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
            return { success: false, message: "المبلغ غير متطابق" };
          }
          return { success: true, amount: apiAmount, currency: "SYP" };
        }
      } catch (error) {
        console.error(`Syriatel error:`, error.message);
      }
    }
    return { success: false, message: "رقم العملية غير موجود" };
  }
}

// ============= دوال إدارة المخازن (Pools) للعبة الدرج =============

// المستويات المؤهلة للمخازن فقط من 1.0 فما فوق
function getPoolLevels() {
    return STAIRCASE_MULTIPLIERS.filter(l => l.multiplier >= 1.0).map(l => l.multiplier);
}

async function getChipPool(betAmount) {
    const poolRef = db.collection('game_pools').doc(`chip_${betAmount}`);
    const poolDoc = await poolRef.get();
    
    if (!poolDoc.exists) {
        const initialPool = {
            chipAmount: betAmount,
            levels: {},
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        for (const level of getPoolLevels()) {
            initialPool.levels[level] = {
                totalAmount: 0,
                contributionCount: 0
            };
        }
        
        await poolRef.set(initialPool);
        return initialPool;
    }
    
    return poolDoc.data();
}

// الحصول على جميع المخازن الممتلئة
async function getFilledPools(betAmount) {
    const pool = await getChipPool(betAmount);
    const filled = [];
    
    for (const multiplier of getPoolLevels()) {
        const levelData = pool.levels[multiplier];
        if (levelData && levelData.totalAmount > 0) {
            filled.push(multiplier);
        }
    }
    
    return filled.sort((a, b) => a - b);
}

// توزيع الخسارة الجزئية على المخازن (للمستويات 1.0 فما فوق فقط)
async function distributePartialLoss(betAmount, lostAmount, explosionMultiplier) {
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

// سحب المكسب من المخزن
async function deductFromPool(betAmount, multiplier, amount) {
    const poolRef = db.collection('game_pools').doc(`chip_${betAmount}`);
    const pool = await getChipPool(betAmount);
    
    const current = pool.levels[multiplier] || { totalAmount: 0 };
    const deducted = Math.min(current.totalAmount, amount);
    
    await poolRef.update({
        [`levels.${multiplier}.totalAmount`]: current.totalAmount - deducted,
        updatedAt: new Date()
    });
    
    return deducted;
}

// ============= خوارزمية تحديد مستوى الانفجار (سري وآمن) =============
async function determineExplosionLevel(betAmount, userBalance) {
    const filledPools = await getFilledPools(betAmount);
    
    // حالة 1: توجد مخازن ممتلئة - فرصة للفوز
    if (filledPools.length > 0) {
        // 65% فرصة للفوز بمخزن ممتلئ (زيادة الأدرينالين)
        const winChance = 0.65;
        if (Math.random() < winChance) {
            const randomIndex = Math.floor(Math.random() * filledPools.length);
            const winMultiplier = filledPools[randomIndex];
            return STAIRCASE_MULTIPLIERS.find(l => l.multiplier === winMultiplier);
        }
    }
    
    // حالة 2: لا توجد مخازن ممتلئة أو الحظ عاند اللاعب
    // الكرة تنفجر قبل الوصول إلى 1.0 (من 0.2 إلى 0.8)
    const lowLevels = STAIRCASE_MULTIPLIERS.filter(l => l.multiplier < 1.0);
    
    // زيادة فرصة الانفجار المبكر إذا كان الرصيد منخفضاً
    const isLowBalance = userBalance < betAmount * 3;
    let explosionIndex;
    
    if (isLowBalance && Math.random() < 0.4) {
        // انفجار مبكر جداً (0.2 أو 0.4)
        explosionIndex = Math.floor(Math.random() * 2);
    } else {
        // انفجار عشوائي بين 0.2 و 0.8 مع ميل للانفجار في المنتصف
        const rand = Math.random();
        if (rand < 0.3) explosionIndex = 0; // 0.2
        else if (rand < 0.6) explosionIndex = 1; // 0.4
        else if (rand < 0.8) explosionIndex = 2; // 0.6
        else explosionIndex = 3; // 0.8
    }
    
    return lowLevels[explosionIndex];
}

// ============= تنفيذ جولة اللعبة =============
async function executeGameRound(userId, betAmount) {
    if (!AVAILABLE_BETS.includes(betAmount)) {
        return { success: false, error: 'مبلغ الرهان غير صالح' };
    }
    
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (!userData) return { success: false, error: 'مستخدم غير موجود' };
    if (userData.isBanned) return { success: false, error: 'حسابك محظور' };
    if ((userData.balance || 0) < betAmount) {
        return { success: false, error: 'الرصيد غير كافٍ' };
    }
    
    // خصم الرهان
    await userRef.update({
        balance: admin.firestore.FieldValue.increment(-betAmount)
    });
    
    // تحديد مستوى الانفجار (خوارزمية سرية)
    const explosionData = await determineExplosionLevel(betAmount, userData.balance);
    const explosionMultiplier = explosionData.multiplier;
    
    let winAmount = 0;
    let refundAmount = 0;
    let isWin = false;
    
    if (explosionMultiplier >= 1.0) {
        // فوز
        isWin = true;
        winAmount = Math.floor(betAmount * explosionMultiplier);
        
        await userRef.update({
            balance: admin.firestore.FieldValue.increment(winAmount)
        });
        
        // سحب المكسب من المخزن
        await deductFromPool(betAmount, explosionMultiplier, winAmount);
        
    } else {
        // خسارة جزئية - استرداد جزء من الرهان
        refundAmount = Math.floor(betAmount * explosionMultiplier);
        const lostAmount = betAmount - refundAmount;
        
        if (refundAmount > 0) {
            await userRef.update({
                balance: admin.firestore.FieldValue.increment(refundAmount)
            });
        }
        
        if (lostAmount > 0) {
            // توزيع الخسارة على المخازن (1.0 فما فوق فقط)
            await distributePartialLoss(betAmount, lostAmount, explosionMultiplier);
        }
    }
    
    // تسجيل الجولة
    const gameRecord = {
        userId,
        userEmail: userData.email,
        userName: userData.name,
        betAmount,
        explosionMultiplier,
        isWin,
        winAmount,
        refundAmount,
        timestamp: new Date()
    };
    
    await db.collection('staircase_games').add(gameRecord);
    
    const updatedUser = await userRef.get();
    
    return {
        success: true,
        result: {
            betAmount,
            explosionMultiplier,
            isWin,
            winAmount,
            refundAmount,
            newBalance: updatedUser.data().balance
        }
    };
}

// ============= دالة عجلة الحظ =============
const WHEEL_SECTORS = [
  { id: 1, name: 'حظ أوفر', type: 'luck', value: 0, probability: 40 },
  { id: 2, name: '10 رصيد أساسي', type: 'balance', value: 10, probability: 10 },
  { id: 3, name: '20 رصيد أساسي', type: 'balance', value: 20, probability: 5 },
  { id: 4, name: '30 رصيد أساسي', type: 'balance', value: 30, probability: 5 },
  { id: 5, name: 'حظ أوفر', type: 'luck', value: 0, probability: 40 },
  { id: 6, name: '10 رصيد أساسي', type: 'balance', value: 10, probability: 10 },
  { id: 7, name: '20 رصيد أساسي', type: 'balance', value: 20, probability: 5 },
  { id: 8, name: '30 رصيد أساسي', type: 'balance', value: 30, probability: 5 }
];

function getRandomSector() {
  const random = Math.random() * 100;
  let cumulative = 0;
  
  for (const sector of WHEEL_SECTORS) {
    cumulative += sector.probability;
    if (random < cumulative) {
      return sector;
    }
  }
  return WHEEL_SECTORS[0];
}

// ============= عمولة الإحالة =============
async function addReferralCommission(userId, depositAmount) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    
    if (userData && userData.referredBy) {
      const settings = await getSettings();
      const commissionPercent = settings.referralCommission || 5;
      const commissionAmount = (depositAmount * commissionPercent) / 100;
      
      if (commissionAmount > 0) {
        const referrerRef = db.collection('users').doc(userData.referredBy);
        
        await referrerRef.update({
          referralBalance: admin.firestore.FieldValue.increment(commissionAmount),
          referralEarnings: admin.firestore.FieldValue.increment(commissionAmount)
        });
        
        await db.collection('referral_commissions').add({
          userId: userData.referredBy,
          fromUserId: userId,
          amount: commissionAmount,
          depositAmount: depositAmount,
          percent: commissionPercent,
          createdAt: new Date()
        });
        
        console.log(`✅ تم إضافة ${commissionAmount} SYP إلى رصيد إحالات المستخدم ${userData.referredBy}`);
      }
    }
  } catch (error) {
    console.error('Commission error:', error);
  }
}

// ============= API التسجيل =============
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const { referrerId } = req.body;
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: email === ADMIN_EMAIL });
    }
    
    const uniqueId = await generateUniqueReferralCode();
    
    let referredBy = null;
    let referrerName = null;
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        referredBy = refQuery.docs[0].id;
        referrerName = refQuery.docs[0].data().name;
        await refQuery.docs[0].ref.update({
          referralBalance: admin.firestore.FieldValue.increment(5),
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
      }
    }
    
    const newUser = {
      uniqueId: uniqueId,
      email,
      name: name || email.split('@')[0],
      balance: 0,
      referralBalance: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      referralEarnings: 0,
      referredBy: referredBy,
      referredByName: referrerName,
      referrals: [],
      createdAt: new Date(),
      isBanned: false,
      lastLogin: new Date(),
      lastSpinTime: null,
      totalSpins: 0,
      totalWinnings: 0
    };
    
    await userRef.set(newUser);
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// ============= API الملف الشخصي =============
app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    res.json({ success: true, user: userDoc.data(), isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

// ============= API الإحصائيات =============
app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    const data = userDoc.data();
    
    let referrerInfo = null;
    if (data.referredBy) {
      const referrerDoc = await db.collection('users').doc(data.referredBy).get();
      if (referrerDoc.exists) {
        referrerInfo = {
          name: referrerDoc.data().name,
          uniqueId: referrerDoc.data().uniqueId
        };
      }
    }
    
    const settings = await getSettings();
    
    res.json({
      success: true,
      stats: {
        referralCount: data.referrals?.length || 0,
        referralEarnings: data.referralEarnings || 0,
        referralBalance: data.referralBalance || 0,
        balance: data.balance || 0,
        totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        uniqueId: data.uniqueId,
        joinDate: data.createdAt,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referrerInfo: referrerInfo,
        siteTheme: settings.siteTheme || 'red',
        totalSpins: data.totalSpins || 0,
        totalWinnings: data.totalWinnings || 0
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// ============= API إعدادات الإيداع =============
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const methods = [];
    
    if (settings.shamCashEnabled && settings.shamCashPublicAddress) {
      methods.push({
        id: 'sham_cash',
        name: 'شام كاش',
        address: settings.shamCashPublicAddress,
        currency: 'SYP',
        icon: '🏦'
      });
    }
    
    if (settings.shamCashUsdEnabled && settings.shamCashUsdPublicAddress) {
      methods.push({
        id: 'sham_cash_usd',
        name: 'شام كاش (دولار)',
        address: settings.shamCashUsdPublicAddress,
        currency: 'USD',
        exchangeRate: settings.usdToSypRate || 13000,
        icon: '💵'
      });
    }
    
    if (settings.syriatelEnabled && settings.syriatelPublicAddress) {
      methods.push({
        id: 'syriatel_cash',
        name: 'سيرياتيل كاش',
        address: settings.syriatelPublicAddress,
        currency: 'SYP',
        icon: '📱'
      });
    }
    
    res.json({
      success: true,
      settings: {
        minDeposit: settings.minDeposit,
        minWithdraw: settings.minWithdraw,
        methods: methods,
        gameImageUrl: settings.gameImageUrl || '',
        usdToSypRate: settings.usdToSypRate || 13000,
        referralCommission: settings.referralCommission || 5,
        siteTheme: settings.siteTheme || 'red',
        wheelSpinCost: settings.wheelSpinCost || 50
      }
    });
  } catch (error) {
    console.error('Deposit settings error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
  }
});

// ============= API الإيداع =============
app.post('/api/user/deposit', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { method, amount, transactionId } = req.body;
    
    if (!method || !amount || !transactionId) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    
    let amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح' });
    }
    
    const settings = await getSettings();
    let verification = null;
    let finalAmountSYP = amountNum;
    let originalCurrency = 'SYP';
    let originalAmount = amountNum;
    
    if (method === 'sham_cash') {
      if (!settings.shamCashEnabled || !settings.shamCashApiKey || !settings.shamCashPrivateAddress) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش غير مفعلة' });
      }
      const client = new ShamCashClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
      verification = await client.verifyTransaction(transactionId, amountNum, 'SYP');
      
      if (verification.success) {
        originalAmount = verification.amount;
        originalCurrency = verification.currency;
        finalAmountSYP = originalAmount;
      }
      
    } else if (method === 'sham_cash_usd') {
      if (!settings.shamCashUsdEnabled || !settings.shamCashUsdApiKey || !settings.shamCashUsdPrivateAddress) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش دولار غير مفعلة' });
      }
      const client = new ShamCashUsdClient(settings.shamCashUsdApiKey, settings.shamCashUsdPrivateAddress);
      verification = await client.verifyTransaction(transactionId, amountNum);
      
      if (verification.success) {
        originalAmount = verification.amount;
        originalCurrency = verification.currency;
        finalAmountSYP = originalAmount * (settings.usdToSypRate || 13000);
      }
      
    } else if (method === 'syriatel_cash') {
      if (!settings.syriatelEnabled || !settings.syriatelApiKey || !settings.syriatelPrivateAddress) {
        return res.status(400).json({ error: 'طريقة الدفع سيرياتيل كاش غير مفعلة' });
      }
      const client = new SyriatelCashClient(settings.syriatelApiKey, [settings.syriatelPrivateAddress]);
      verification = await client.verifyTransaction(transactionId, amountNum);
      
      if (verification.success) {
        originalAmount = verification.amount;
        originalCurrency = verification.currency || 'SYP';
        finalAmountSYP = originalAmount;
      }
    } else {
      return res.status(400).json({ error: 'طريقة دفع غير مدعومة' });
    }
    
    if (!verification || !verification.success) {
      return res.status(400).json({ error: verification?.message || 'فشل التحقق' });
    }
    
    if (finalAmountSYP < settings.minDeposit) {
      return res.status(400).json({ error: `الحد الأدنى ${settings.minDeposit} SYP` });
    }
    
    const existing = await db.collection('deposits').where('transactionId', '==', transactionId).limit(1).get();
    if (!existing.empty) {
      return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً' });
    }
    
    const userRef = db.collection('users').doc(uid);
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(finalAmountSYP),
      totalDeposited: admin.firestore.FieldValue.increment(finalAmountSYP)
    });
    
    await db.collection('deposits').add({
      userId: uid,
      method: method,
      amount: finalAmountSYP,
      originalAmount: originalAmount,
      originalCurrency: originalCurrency,
      transactionId: transactionId,
      status: 'completed',
      verifiedAt: new Date(),
      exchangeRate: method === 'sham_cash_usd' ? settings.usdToSypRate : null
    });
    
    await addReferralCommission(uid, finalAmountSYP);
    
    const updatedUser = await userRef.get();
    res.json({ success: true, message: `تم إيداع ${finalAmountSYP.toLocaleString()} SYP`, newBalance: updatedUser.data().balance });
    
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي' });
  }
});

// ============= API جلب الإيداعات =============
app.get('/api/user/deposits', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits')
      .where('userId', '==', req.user.uid)
      .orderBy('verifiedAt', 'desc')
      .get();
    
    const deposits = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      deposits.push({
        id: doc.id,
        amount: data.amount || 0,
        method: data.method || 'unknown',
        transactionId: data.transactionId || 'N/A',
        verifiedAt: data.verifiedAt?.toDate ? data.verifiedAt.toDate() : new Date(data.verifiedAt),
        status: data.status || 'completed'
      });
    });
    
    res.json({ success: true, deposits });
  } catch (error) {
    console.error('Get deposits error:', error);
    res.json({ success: true, deposits: [] });
  }
});

// ============= API إضافة كود إحالة =============
app.post('/api/user/add-referrer', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { referrerCode } = req.body;
    
    if (!referrerCode) {
      return res.status(400).json({ error: 'كود الإحالة مطلوب' });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (userData.referredBy) {
      return res.status(400).json({ error: 'لديك محيل بالفعل' });
    }
    
    const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerCode).limit(1).get();
    if (referrerQuery.empty) {
      return res.status(404).json({ error: 'كود الإحالة غير صحيح' });
    }
    
    const referrerDoc = referrerQuery.docs[0];
    const referrerId = referrerDoc.id;
    
    if (referrerId === uid) {
      return res.status(400).json({ error: 'لا يمكنك إحالة نفسك' });
    }
    
    await userRef.update({
      referredBy: referrerId,
      referredByName: referrerDoc.data().name
    });
    
    await referrerDoc.ref.update({
      referralBalance: admin.firestore.FieldValue.increment(5),
      referralEarnings: admin.firestore.FieldValue.increment(5),
      referrals: admin.firestore.FieldValue.arrayUnion(uid)
    });
    
    res.json({ success: true, message: `تم إضافة المحيل: ${referrerDoc.data().name}` });
    
  } catch (error) {
    console.error('Add referrer error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ============= API السحب =============
app.post('/api/user/withdraw', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { amount, address, method } = req.body;
    
    if (!amount || !address) {
      return res.status(400).json({ error: 'المبلغ والعنوان مطلوبان' });
    }
    
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح' });
    }
    
    const settings = await getSettings();
    if (amountNum < settings.minWithdraw) {
      return res.status(400).json({ error: `الحد الأدنى ${settings.minWithdraw} SYP` });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (!userData) return res.status(404).json({ error: 'مستخدم غير موجود' });
    if (userData.isBanned) return res.status(403).json({ error: 'حسابك محظور' });
    if (userData.balance < amountNum) return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-amountNum),
      totalWithdrawn: admin.firestore.FieldValue.increment(amountNum)
    });
    
    await db.collection('withdraw_requests').add({
      userId: uid,
      userEmail: userData.email,
      userName: userData.name,
      amount: amountNum,
      address: address,
      method: method || 'sham_cash',
      status: 'pending',
      createdAt: new Date()
    });
    
    res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP` });
    
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'فشل إنشاء طلب السحب' });
  }
});

// ============= API جلب السحوبات =============
app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .get();
    
    const requests = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      requests.push({
        id: doc.id,
        amount: data.amount || 0,
        address: data.address || 'N/A',
        method: data.method || 'unknown',
        status: data.status || 'pending',
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt)
      });
    });
    
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get withdrawals error:', error);
    res.json({ success: true, requests: [] });
  }
});

// ============= APIs لعبة الدرج =============

// جلب قائمة الفيش المتاحة
app.get('/api/game/bets', requireAuth, async (req, res) => {
    res.json({ success: true, availableBets: AVAILABLE_BETS });
});

// تنفيذ رهان اللعبة
app.post('/api/game/bet', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const { betAmount } = req.body;
        
        const result = await executeGameRound(uid, Number(betAmount));
        
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }
        
        res.json(result);
        
    } catch (error) {
        console.error('Game bet error:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء اللعب' });
    }
});

// جلب تاريخ ألعاب المستخدم
app.get('/api/game/history', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const snapshot = await db.collection('staircase_games')
            .where('userId', '==', uid)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
        
        const games = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            games.push({
                betAmount: d.betAmount,
                explosionMultiplier: d.explosionMultiplier,
                isWin: d.isWin,
                winAmount: d.winAmount || 0,
                refundAmount: d.refundAmount || 0,
                timestamp: d.timestamp?.toDate?.() || new Date(d.timestamp)
            });
        });
        
        res.json({ success: true, games });
    } catch (error) {
        res.json({ success: true, games: [] });
    }
});

// ============= API عجلة الحظ =============
app.get('/api/user/wheel-status', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    const settings = await getSettings();
    
    const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
    const now = new Date();
    let canSpin = true;
    let remainingSeconds = 0;
    
    if (lastSpin) {
      const timeDiff = (now - lastSpin) / 1000;
      if (timeDiff < 300) {
        canSpin = false;
        remainingSeconds = Math.ceil(300 - timeDiff);
      }
    }
    
    res.json({
      success: true,
      canSpin: canSpin,
      remainingSeconds: remainingSeconds,
      spinCost: settings.wheelSpinCost || 50,
      referralBalance: userData.referralBalance || 0,
      hasEnoughBalance: (userData.referralBalance || 0) >= (settings.wheelSpinCost || 50)
    });
  } catch (error) {
    console.error('Wheel status error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

app.post('/api/user/spin-wheel', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (!userData) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    
    const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
    const now = new Date();
    
    if (lastSpin) {
      const timeDiff = (now - lastSpin) / 1000;
      if (timeDiff < 300) {
        const remainingSeconds = Math.ceil(300 - timeDiff);
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        return res.status(400).json({ 
          error: `يجب الانتظار ${minutes} دقيقة و ${seconds} ثانية قبل التدوير مرة أخرى` 
        });
      }
    }
    
    const settings = await getSettings();
    const spinCost = settings.wheelSpinCost || 50;
    
    if ((userData.referralBalance || 0) < spinCost) {
      return res.status(400).json({ error: `رصيد الإحالات غير كافٍ. تحتاج ${spinCost} SYP للتدوير` });
    }
    
    const selectedSector = getRandomSector();
    let prizeAmount = 0;
    let prizeMessage = '';
    
    if (selectedSector.type === 'balance') {
      prizeAmount = selectedSector.value;
      prizeMessage = `🎉 فزت بـ ${prizeAmount} SYP! تم إضافتها إلى رصيدك الأساسي`;
      
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(prizeAmount),
        referralBalance: admin.firestore.FieldValue.increment(-spinCost),
        lastSpinTime: now,
        totalSpins: admin.firestore.FieldValue.increment(1),
        totalWinnings: admin.firestore.FieldValue.increment(prizeAmount)
      });
    } else {
      prizeMessage = `😅 حظ أوفر! لم تربح هذه المرة. حظاً أفضل في المرة القادمة`;
      
      await userRef.update({
        referralBalance: admin.firestore.FieldValue.increment(-spinCost),
        lastSpinTime: now,
        totalSpins: admin.firestore.FieldValue.increment(1)
      });
    }
    
    await db.collection('wheel_spins').add({
      userId: uid,
      sector: selectedSector.id,
      sectorName: selectedSector.name,
      prizeAmount: prizeAmount,
      prizeType: selectedSector.type,
      spinCost: spinCost,
      timestamp: now,
      userEmail: userData.email,
      userName: userData.name
    });
    
    const updatedUser = await userRef.get();
    const updatedData = updatedUser.data();
    
    res.json({
      success: true,
      sector: selectedSector.id,
      sectorName: selectedSector.name,
      prizeAmount: prizeAmount,
      prizeType: selectedSector.type,
      message: prizeMessage,
      newBalance: updatedData.balance || 0,
      newReferralBalance: updatedData.referralBalance || 0,
      spinCost: spinCost
    });
    
  } catch (error) {
    console.error('Spin wheel error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء التدوير' });
  }
});

app.get('/api/user/wheel-history', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const snapshot = await db.collection('wheel_spins')
      .where('userId', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    
    const spins = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      spins.push({
        id: doc.id,
        sectorName: data.sectorName,
        prizeAmount: data.prizeAmount || 0,
        prizeType: data.prizeType,
        spinCost: data.spinCost,
        timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : new Date(data.timestamp)
      });
    });
    
    res.json({ success: true, spins });
  } catch (error) {
    console.error('Wheel history error:', error);
    res.json({ success: true, spins: [] });
  }
});

// ============= APIs الأدمن =============
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, settings });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    await db.collection('settings').doc('config').update(req.body);
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'فشل تحديث الإعدادات' });
  }
});

app.post('/api/admin/update-theme', requireAdmin, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme) {
      return res.status(400).json({ error: 'اللون مطلوب' });
    }
    
    await db.collection('settings').doc('config').update({ siteTheme: theme });
    res.json({ success: true, message: `تم تغيير لون الموقع إلى ${theme}` });
  } catch (error) {
    console.error('Update theme error:', error);
    res.status(500).json({ error: 'فشل تغيير اللون' });
  }
});

app.get('/api/site-theme', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, theme: settings.siteTheme || 'red' });
  } catch (error) {
    console.error('Get theme error:', error);
    res.json({ success: true, theme: 'red' });
  }
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const users = [];
    usersSnapshot.forEach(doc => users.push(doc.data()));
    
    const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
    const totalDeposited = users.reduce((s, u) => s + (u.totalDeposited || 0), 0);
    const totalWithdrawn = users.reduce((s, u) => s + (u.totalWithdrawn || 0), 0);
    const totalReferralEarnings = users.reduce((s, u) => s + (u.referralEarnings || 0), 0);
    
    const pendingSnapshot = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newToday = users.filter(u => {
      if (!u.createdAt) return false;
      const date = u.createdAt.toDate ? u.createdAt.toDate() : u.createdAt;
      return date > today;
    }).length;
    
    const wheelSpinsSnapshot = await db.collection('wheel_spins').get();
    const totalSpins = wheelSpinsSnapshot.size;
    const totalWinnings = wheelSpinsSnapshot.docs.reduce((sum, doc) => sum + (doc.data().prizeAmount || 0), 0);
    
    // إحصائيات لعبة الدرج
    const staircaseGamesSnapshot = await db.collection('staircase_games').get();
    const totalGames = staircaseGamesSnapshot.size;
    let totalGameBets = 0;
    let totalGamePayouts = 0;
    staircaseGamesSnapshot.forEach(doc => {
      const d = doc.data();
      totalGameBets += d.betAmount;
      if (d.isWin) totalGamePayouts += d.winAmount;
    });
    
    res.json({
      success: true,
      stats: {
        totalUsers: usersSnapshot.size,
        newToday,
        totalBalance,
        totalDeposited,
        totalWithdrawn,
        totalReferralEarnings,
        pendingWithdrawals: pendingSnapshot.size,
        totalSpins,
        totalWinnings,
        totalGames,
        totalGameBets,
        totalGamePayouts,
        gameHouseProfit: totalGameBets - totalGamePayouts
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

app.get('/api/admin/withdraw-requests', requireAdmin, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    let query = db.collection('withdraw_requests').orderBy('createdAt', 'desc');
    if (status !== 'all') query = query.where('status', '==', status);
    
    const snapshot = await query.get();
    const requests = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      requests.push({
        id: doc.id,
        userId: data.userId,
        userEmail: data.userEmail,
        userName: data.userName,
        amount: data.amount,
        address: data.address,
        status: data.status,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt)
      });
    }
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Admin withdraws error:', error);
    res.status(500).json({ error: 'خطأ في جلب الطلبات' });
  }
});

app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
  try {
    const { requestId, action } = req.body;
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();
    
    if (!requestDoc.exists) return res.status(404).json({ error: 'طلب غير موجود' });
    
    const request = requestDoc.data();
    if (request.status !== 'pending') return res.status(400).json({ error: 'تم معالجة هذا الطلب' });
    
    if (action === 'reject') {
      await db.collection('users').doc(request.userId).update({
        balance: admin.firestore.FieldValue.increment(request.amount)
      });
    }
    
    await requestRef.update({
      status: action === 'approve' ? 'approved' : 'rejected',
      processedAt: new Date(),
      processedBy: req.user.email
    });
    
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب` });
  } catch (error) {
    console.error('Process withdraw error:', error);
    res.status(500).json({ error: 'فشل معالجة الطلب' });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits').orderBy('verifiedAt', 'desc').limit(100).get();
    const deposits = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      deposits.push({
        id: doc.id,
        userId: data.userId,
        userEmail: userDoc.exists ? userDoc.data().email : null,
        userName: userDoc.exists ? userDoc.data().name : null,
        amount: data.amount,
        method: data.method,
        transactionId: data.transactionId,
        verifiedAt: data.verifiedAt?.toDate ? data.verifiedAt.toDate() : new Date(data.verifiedAt)
      });
    }
    res.json({ success: true, deposits });
  } catch (error) {
    console.error('Admin deposits error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإيداعات' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users').orderBy('createdAt', 'desc').get();
    const users = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      users.push({
        id: doc.id,
        email: data.email,
        name: data.name,
        uniqueId: data.uniqueId,
        balance: data.balance,
        referralBalance: data.referralBalance || 0,
        isBanned: data.isBanned || false,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referralEarnings: data.referralEarnings || 0,
        referralsCount: data.referrals?.length || 0,
        totalSpins: data.totalSpins || 0,
        totalWinnings: data.totalWinnings || 0
      });
    });
    res.json({ success: true, users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
  }
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    await db.collection('users').doc(userId).update({
      balance: admin.firestore.FieldValue.increment(Number(amount))
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'فشل تحديث الرصيد' });
  }
});

app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const userDoc = await db.collection('users').doc(userId).get();
    const currentBan = userDoc.data()?.isBanned || false;
    await db.collection('users').doc(userId).update({ isBanned: !currentBan });
    res.json({ success: true, isBanned: !currentBan });
  } catch (error) {
    console.error('Toggle ban error:', error);
    res.status(500).json({ error: 'فشل تحديث حالة الحظر' });
  }
});

app.post('/api/admin/update-wheel-cost', requireAdmin, async (req, res) => {
  try {
    const { cost } = req.body;
    if (!cost || cost < 10 || cost > 10000) {
      return res.status(400).json({ error: 'سعر غير صالح (يجب أن يكون بين 10 و 10000)' });
    }
    await db.collection('settings').doc('config').update({ wheelSpinCost: cost });
    res.json({ success: true, message: `تم تحديث سعر التدويرة إلى ${cost} SYP` });
  } catch (error) {
    console.error('Update wheel cost error:', error);
    res.status(500).json({ error: 'فشل تحديث السعر' });
  }
});

// ============= APIs الأدمن للعبة الدرج =============

// جلب حالة جميع المخازن
app.get('/api/admin/game-pools', requireAdmin, async (req, res) => {
  try {
    const pools = {};
    for (const bet of AVAILABLE_BETS) {
      const pool = await getChipPool(bet);
      pools[bet] = pool.levels;
    }
    res.json({ success: true, pools });
  } catch (error) {
    console.error('Get pools error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// إضافة رصيد إلى مخزن معين (للأدمن - لضبط التوازن)
app.post('/api/admin/add-to-pool', requireAdmin, async (req, res) => {
  try {
    const { chipAmount, multiplier, amount } = req.body;
    
    if (!AVAILABLE_BETS.includes(chipAmount)) {
      return res.status(400).json({ error: 'قيمة الفيشة غير صالحة' });
    }
    
    const poolRef = db.collection('game_pools').doc(`chip_${chipAmount}`);
    const pool = await getChipPool(chipAmount);
    
    const currentAmount = pool.levels[multiplier]?.totalAmount || 0;
    
    await poolRef.update({
      [`levels.${multiplier}.totalAmount`]: currentAmount + amount,
      [`levels.${multiplier}.lastUpdated`]: new Date(),
      updatedAt: new Date()
    });
    
    res.json({ success: true, message: `تمت إضافة ${amount} SYP إلى مخزن ${chipAmount} / ${multiplier}` });
  } catch (error) {
    console.error('Add to pool error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// إحصائيات لعبة الدرج العامة
app.get('/api/admin/game-stats', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('staircase_games').get();
    
    let totalBets = 0;
    let totalPayouts = 0;
    let totalRefunds = 0;
    let winsCount = 0;
    let lossesCount = 0;
    
    snapshot.forEach(doc => {
      const data = doc.data();
      totalBets += data.betAmount;
      if (data.isWin) {
        totalPayouts += data.winAmount || 0;
        winsCount++;
      } else {
        totalRefunds += data.refundAmount || 0;
        lossesCount++;
      }
    });
    
    const houseProfit = totalBets - totalPayouts - totalRefunds;
    
    res.json({
      success: true,
      stats: {
        totalGames: snapshot.size,
        winsCount,
        lossesCount,
        totalBets,
        totalPayouts,
        totalRefunds,
        houseProfit,
        houseEdgePercent: totalBets > 0 ? ((houseProfit / totalBets) * 100).toFixed(2) : 0
      }
    });
  } catch (error) {
    console.error('Game stats error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== RESET_PASSWORD) {
      return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
    }
    
    const collections = ['users', 'withdraw_requests', 'deposits', 'referral_commissions', 'wheel_spins', 'staircase_games', 'game_pools'];
    for (const col of collections) {
      const snapshot = await db.collection(col).get();
      const deletions = [];
      snapshot.forEach(doc => deletions.push(db.collection(col).doc(doc.id).delete()));
      await Promise.all(deletions);
    }
    
    const defaultSettings = {
      minDeposit: 1000, minWithdraw: 5000, shamCashEnabled: true, syriatelEnabled: true,
      shamCashUsdEnabled: false, usdToSypRate: 13000, referralCommission: 5, wheelSpinCost: 50,
      shamCashApiKey: '', shamCashPrivateAddress: '', shamCashPublicAddress: '0930000000',
      shamCashUsdApiKey: '', shamCashUsdPrivateAddress: '', shamCashUsdPublicAddress: '',
      syriatelApiKey: '', syriatelPrivateAddress: '', syriatelPublicAddress: '0930000000',
      gameImageUrl: '', siteTheme: 'red', siteName: 'BOOMB', maintenanceMode: false
    };
    await db.collection('settings').doc('config').set(defaultSettings);
    
    res.json({ success: true, message: 'تم تهيئة قاعدة البيانات بنجاح' });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'فشل التهيئة' });
  }
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🎰 Wheel system ready with 8 sectors`);
  console.log(`🎲 Staircase Game with ${AVAILABLE_BETS.length} chip types and ${STAIRCASE_MULTIPLIERS.length} levels`);
  console.log(`💰 Pool system active for multipliers >= 1.0x`);
});
