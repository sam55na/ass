import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import axios from 'axios';

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
app.use(cors({
  origin: [
    'https://sam55na.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.static('.'));

// ============= الجلسات =============
app.use(session({
  secret: 'boomb_admin_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ============= منع التكرار =============
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: 'الرجاء الانتظار دقيقة'
});
app.use('/api/', limiter);

const actionCooldown = new Map();
function checkCooldown(userId, action, seconds = 60) {
  const key = `${userId}:${action}`;
  const last = actionCooldown.get(key);
  const now = Date.now();
  if (last && (now - last) < seconds * 1000) {
    return { allowed: false, remaining: Math.ceil((seconds * 1000 - (now - last)) / 1000) };
  }
  actionCooldown.set(key, now);
  return { allowed: true, remaining: 0 };
}

// ============= دوال مساعدة =============
function generateUniqueId() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

const ADMIN_EMAIL = 'sam55nam@gmail.com';

const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'ليس لديك صلاحيات أدمن' });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

// ============= كلاس شام كاش =============
class ShamCashClient {
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
            const apiCurrency = item.currency?.toUpperCase() || "SYP";
            
            const timestamp = item.created_at || Date.now() / 1000;
            const timeDiff = Date.now() / 1000 - timestamp;
            if (timeDiff > 86400) {
              return { success: false, message: "العملية أقدم من 24 ساعة", code: "EXPIRED" };
            }
            
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: المبلغ الفعلي ${apiAmount}`, code: "AMOUNT_MISMATCH" };
            }
            
            return {
              success: true,
              txid: txid,
              amount: apiAmount,
              currency: apiCurrency,
              status: "completed",
              timestamp: timestamp
            };
          }
        }
        return { success: false, message: "رقم العملية غير موجود", code: "NOT_FOUND" };
      }
      return { success: false, message: "فشل التحقق من العملية", code: "API_ERROR" };
    } catch (error) {
      console.error("ShamCash error:", error);
      return { success: false, message: error.message, code: "EXCEPTION" };
    }
  }
}

// ============= كلاس سيرياتيل كاش =============
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
            return { success: false, message: "المبلغ غير متطابق", code: "AMOUNT_MISMATCH" };
          }
          
          return {
            success: true,
            txid: txid,
            amount: apiAmount,
            currency: "SYP",
            status: "completed",
            gsm: gsm,
            timestamp: transaction.date || Date.now()
          };
        }
      } catch (error) {
        console.error(`Syriatel error for ${gsm}:`, error.message);
      }
    }
    return { success: false, message: "رقم العملية غير موجود", code: "NOT_FOUND" };
  }
}

// ============= إعدادات النظام =============
async function getSystemSettings() {
  const settingsRef = db.collection('system_settings').doc('config');
  const doc = await settingsRef.get();
  if (doc.exists) {
    return doc.data();
  }
  const defaultSettings = {
    minDeposit: 1000,
    minWithdraw: 5000,
    shamCashAddress: "",
    shamCashApiKey: "",
    shamCashEnabled: true,
    syriatelApiKey: "",
    syriatelNumbers: [],
    syriatelEnabled: true
  };
  await settingsRef.set(defaultSettings);
  return defaultSettings;
}

// ============= API المستخدمين =============
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name, picture } = req.user;
    const { referrerId } = req.body;
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: email === ADMIN_EMAIL });
    }
    
    const newUser = {
      uniqueId: generateUniqueId(),
      email,
      name: name || email.split('@')[0],
      photoURL: picture || null,
      balance: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      referralEarnings: 0,
      referredBy: referrerId || null,
      referrals: [],
      createdAt: new Date(),
      lastActive: new Date(),
      isBanned: false
    };
    
    await userRef.set(newUser);
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        await refQuery.docs[0].ref.update({
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
      }
    }
    
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({ success: true, user: userDoc.data(), isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const data = userDoc.data();
    res.json({
      success: true,
      stats: {
        referralCount: data.referrals?.length || 0,
        totalReferralEarnings: data.referralEarnings || 0,
        balance: data.balance || 0,
        totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        uniqueId: data.uniqueId,
        joinDate: data.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// ============= API الإيداع =============
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
  try {
    const settings = await getSystemSettings();
    res.json({
      success: true,
      settings: {
        minDeposit: settings.minDeposit,
        minWithdraw: settings.minWithdraw,
        methods: [
          {
            id: 'sham_cash',
            name: 'شام كاش',
            enabled: settings.shamCashEnabled,
            address: settings.shamCashAddress
          },
          {
            id: 'syriatel_cash',
            name: 'سيرياتيل كاش',
            enabled: settings.syriatelEnabled,
            numbers: settings.syriatelNumbers
          }
        ]
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
  }
});

app.post('/api/user/deposit', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { method, amount, transactionId } = req.body;
    
    if (!method || !amount || !transactionId) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    
    const settings = await getSystemSettings();
    
    if (method === 'sham_cash' && !settings.shamCashEnabled) {
      return res.status(400).json({ error: 'طريقة الدفع شام كاش معطلة حالياً' });
    }
    if (method === 'syriatel_cash' && !settings.syriatelEnabled) {
      return res.status(400).json({ error: 'طريقة الدفع سيرياتيل كاش معطلة حالياً' });
    }
    
    if (amount < settings.minDeposit) {
      return res.status(400).json({ error: `الحد الأدنى للإيداع ${settings.minDeposit} SYP` });
    }
    
    let verification = null;
    
    if (method === 'sham_cash') {
      if (!settings.shamCashApiKey || !settings.shamCashAddress) {
        return res.status(400).json({ error: 'بيانات شام كاش غير مكتملة' });
      }
      const shamCash = new ShamCashClient(settings.shamCashApiKey, settings.shamCashAddress);
      verification = await shamCash.verifyTransaction(transactionId, amount);
    } else if (method === 'syriatel_cash') {
      if (!settings.syriatelApiKey || !settings.syriatelNumbers.length) {
        return res.status(400).json({ error: 'بيانات سيرياتيل كاش غير مكتملة' });
      }
      const syriatel = new SyriatelCashClient(settings.syriatelApiKey, settings.syriatelNumbers);
      verification = await syriatel.verifyTransaction(transactionId, amount);
    } else {
      return res.status(400).json({ error: 'طريقة دفع غير مدعومة' });
    }
    
    if (!verification.success) {
      return res.status(400).json({ error: verification.message });
    }
    
    const existingDeposit = await db.collection('deposits')
      .where('transactionId', '==', transactionId)
      .limit(1)
      .get();
    
    if (!existingDeposit.empty) {
      return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً' });
    }
    
    const userRef = db.collection('users').doc(uid);
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(verification.amount),
      totalDeposited: admin.firestore.FieldValue.increment(verification.amount)
    });
    
    await db.collection('deposits').add({
      userId: uid,
      transactionId: transactionId,
      method: method,
      amount: verification.amount,
      currency: verification.currency || 'SYP',
      status: 'completed',
      verifiedAt: new Date()
    });
    
    await db.collection('transactions').add({
      userId: uid,
      type: 'deposit',
      amount: verification.amount,
      method: method,
      transactionId: transactionId,
      status: 'completed',
      createdAt: new Date()
    });
    
    const updatedUser = await userRef.get();
    
    res.json({ 
      success: true, 
      message: `تم إيداع ${verification.amount} SYP بنجاح`,
      amount: verification.amount,
      newBalance: updatedUser.data().balance
    });
    
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
  }
});

app.get('/api/user/deposits', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const deposits = await db.collection('deposits')
      .where('userId', '==', uid)
      .orderBy('verifiedAt', 'desc')
      .limit(20)
      .get();
    
    const depositsList = [];
    for (const doc of deposits.docs) {
      const data = doc.data();
      depositsList.push({
        id: doc.id,
        amount: data.amount,
        method: data.method,
        transactionId: data.transactionId,
        status: data.status,
        verifiedAt: data.verifiedAt?.toDate?.()
      });
    }
    
    res.json({ success: true, deposits: depositsList });
  } catch (error) {
    console.error('Get deposits error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإيداعات' });
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
    
    const settings = await getSystemSettings();
    
    if (amount < settings.minWithdraw) {
      return res.status(400).json({ error: `الحد الأدنى للسحب ${settings.minWithdraw} SYP` });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (!userData) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    
    if (userData.balance < amount) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    }
    
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-amount),
      totalWithdrawn: admin.firestore.FieldValue.increment(amount)
    });
    
    const withdrawRequest = {
      userId: uid,
      userEmail: userData.email,
      userName: userData.name,
      userUniqueId: userData.uniqueId,
      amount: amount,
      address: address,
      method: method || 'sham_cash',
      status: 'pending',
      createdAt: new Date(),
      previousBalance: userData.balance,
      newBalance: userData.balance - amount
    };
    
    const requestRef = await db.collection('withdraw_requests').add(withdrawRequest);
    
    await db.collection('transactions').add({
      userId: uid,
      type: 'withdraw_request',
      amount: amount,
      requestId: requestRef.id,
      status: 'pending',
      createdAt: new Date()
    });
    
    res.json({ 
      success: true, 
      message: `تم إنشاء طلب سحب بمبلغ ${amount} SYP، قيد المراجعة`,
      requestId: requestRef.id
    });
    
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'فشل إنشاء طلب السحب' });
  }
});

app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const requests = await db.collection('withdraw_requests')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    
    const requestsList = [];
    for (const doc of requests.docs) {
      const data = doc.data();
      requestsList.push({
        id: doc.id,
        amount: data.amount,
        address: data.address,
        method: data.method,
        status: data.status,
        createdAt: data.createdAt?.toDate?.()
      });
    }
    
    res.json({ success: true, requests: requestsList });
  } catch (error) {
    console.error('Get withdraw requests error:', error);
    res.status(500).json({ error: 'خطأ في جلب طلبات السحب' });
  }
});

// ============= APIs الأدمن =============
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await getSystemSettings();
  res.json({ success: true, settings });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    const settingsRef = db.collection('system_settings').doc('config');
    await settingsRef.update(updates);
    
    await db.collection('adminLogs').add({
      adminEmail: req.user.email,
      action: 'update_settings',
      changes: updates,
      timestamp: new Date()
    });
    
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'فشل تحديث الإعدادات' });
  }
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const users = usersSnapshot.docs.map(doc => doc.data());
    const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);
    const totalDeposited = users.reduce((sum, u) => sum + (u.totalDeposited || 0), 0);
    const totalWithdrawn = users.reduce((sum, u) => sum + (u.totalWithdrawn || 0), 0);
    
    const pendingWithdrawals = await db.collection('withdraw_requests')
      .where('status', '==', 'pending')
      .get();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newToday = users.filter(u => u.createdAt?.toDate() > today).length;
    
    res.json({
      success: true,
      stats: {
        totalUsers: usersSnapshot.size,
        newToday,
        totalBalance,
        totalDeposited,
        totalWithdrawn,
        pendingWithdrawals: pendingWithdrawals.size
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

app.get('/api/admin/withdraw-requests', requireAdmin, async (req, res) => {
  try {
    const { status = 'all', page = 1, limit = 50 } = req.query;
    let query = db.collection('withdraw_requests').orderBy('createdAt', 'desc');
    
    if (status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    const snapshot = await query.get();
    let requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    const start = (page - 1) * limit;
    const paginated = requests.slice(start, start + limit);
    
    res.json({
      success: true,
      requests: paginated,
      total: requests.length,
      page: Number(page),
      totalPages: Math.ceil(requests.length / limit)
    });
  } catch (error) {
    console.error('Admin withdraws error:', error);
    res.status(500).json({ error: 'خطأ في جلب الطلبات' });
  }
});

app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
  try {
    const { requestId, action, adminNotes } = req.body;
    
    if (!requestId || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'بيانات غير صالحة' });
    }
    
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();
    
    if (!requestDoc.exists) {
      return res.status(404).json({ error: 'طلب غير موجود' });
    }
    
    const request = requestDoc.data();
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً' });
    }
    
    if (action === 'reject') {
      const userRef = db.collection('users').doc(request.userId);
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(request.amount)
      });
    }
    
    await requestRef.update({
      status: action === 'approve' ? 'approved' : 'rejected',
      processedAt: new Date(),
      processedBy: req.user.email,
      adminNotes: adminNotes || ''
    });
    
    await db.collection('transactions').add({
      userId: request.userId,
      type: 'withdraw',
      amount: request.amount,
      requestId: requestId,
      status: action === 'approve' ? 'completed' : 'rejected',
      processedBy: req.user.email,
      createdAt: new Date()
    });
    
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب` });
  } catch (error) {
    console.error('Process withdraw error:', error);
    res.status(500).json({ error: 'فشل معالجة الطلب' });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const snapshot = await db.collection('deposits')
      .orderBy('verifiedAt', 'desc')
      .get();
    
    const deposits = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const start = (page - 1) * limit;
    
    const depositsWithUser = await Promise.all(deposits.slice(start, start + limit).map(async (dep) => {
      const userDoc = await db.collection('users').doc(dep.userId).get();
      return { ...dep, user: userDoc.exists ? userDoc.data() : null };
    }));
    
    res.json({
      success: true,
      deposits: depositsWithUser,
      total: deposits.length,
      page: Number(page),
      totalPages: Math.ceil(deposits.length / limit)
    });
  } catch (error) {
    console.error('Admin deposits error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإيداعات' });
  }
});

// ============= نقاط الاختبار =============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin email: ${ADMIN_EMAIL}`);
});
