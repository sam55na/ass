import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

app.use(cors({
  origin: [
    'https://sam55na.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://ass-yygm.onrender.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static('.'));

// ============= الجلسات =============
app.use(session({
  secret: 'boomb_admin_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 ساعة
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

function generateTransactionId() {
  return 'TXN' + Date.now() + Math.floor(Math.random() * 10000);
}

const isAdminEmail = (email) => email === 'sam55nam@gmail.com';

// التحقق من صلاحيات الأدمن
const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (!isAdminEmail(decoded.email)) {
      return res.status(403).json({ error: 'ليس لديك صلاحيات أدمن' });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

// التحقق من التوكن العادي
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

// ============= نقاط الاختبار =============
app.get('/', (req, res) => {
  res.send('BOOMB Server is Running ✅');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// ============= API المستخدمين =============

// تسجيل/جلب المستخدم
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name, picture } = req.user;
    const { referrerId } = req.body;
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: isAdminEmail(email) });
    }
    
    let finalReferrer = null;
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) finalReferrer = referrerId;
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
      referredBy: finalReferrer,
      referrals: [],
      createdAt: new Date(),
      lastActive: new Date(),
      isBanned: false,
      isVerified: true,
      role: 'user'
    };
    
    await userRef.set(newUser);
    
    if (finalReferrer) {
      const refDoc = await db.collection('users').where('uniqueId', '==', finalReferrer).limit(1).get();
      if (!refDoc.empty) {
        await refDoc.docs[0].ref.update({
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
        await db.collection('transactions').add({
          userId: refDoc.docs[0].id,
          type: 'referral_bonus',
          amount: 5,
          fromUser: uid,
          description: `مكافأة إحالة مستخدم جديد`,
          createdAt: new Date()
        });
      }
    }
    
    res.json({ success: true, user: newUser, isAdmin: isAdminEmail(email) });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// جلب بيانات المستخدم
app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({ success: true, user: userDoc.data(), isAdmin: isAdminEmail(req.user.email) });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// جلب الإحصائيات
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
        joinDate: data.createdAt,
        lastActive: data.lastActive
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// جلب آخر الطلبات
app.get('/api/user/requests', requireAuth, async (req, res) => {
  try {
    const requests = await db.collection('requests')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    
    res.json({
      success: true,
      requests: requests.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }))
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// إنشاء طلب جديد
app.post('/api/user/create-request', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { type, amount, details } = req.body;
    
    if (!type || !amount || amount <= 0) {
      return res.status(400).json({ error: 'بيانات غير صالحة' });
    }
    
    if (!['deposit', 'withdraw'].includes(type)) {
      return res.status(400).json({ error: 'نوع طلب غير صالح' });
    }
    
    const cooldown = checkCooldown(uid, 'request', 60);
    if (!cooldown.allowed) {
      return res.status(429).json({ error: `انتظر ${cooldown.remaining} ثانية` });
    }
    
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();
    
    if (type === 'withdraw' && amount > (userData.balance || 0)) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    }
    
    const request = {
      userId: uid,
      type,
      amount: Number(amount),
      status: 'pending',
      details: details || {},
      createdAt: new Date()
    };
    
    const docRef = await db.collection('requests').add(request);
    
    await db.collection('transactions').add({
      userId: uid,
      type: `${type}_request`,
      amount: Number(amount),
      requestId: docRef.id,
      status: 'pending',
      createdAt: new Date()
    });
    
    res.json({ success: true, requestId: docRef.id });
  } catch (error) {
    console.error('Create request error:', error);
    res.status(500).json({ error: 'فشل إنشاء الطلب' });
  }
});

// ============= نظام الإحالات المتقدم =============

// جلب إحالات المستخدم
app.get('/api/user/referrals', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();
    const referrals = userData.referrals || [];
    
    const referralDetails = [];
    for (const refId of referrals.slice(-20)) {
      const refDoc = await db.collection('users').doc(refId).get();
      if (refDoc.exists) {
        referralDetails.push({
          name: refDoc.data().name,
          email: refDoc.data().email,
          joinedAt: refDoc.data().createdAt,
          earned: 5
        });
      }
    }
    
    res.json({ success: true, referrals: referralDetails, count: referrals.length });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// ============= نظام الأدمن المتكامل =============

// لوحة تحكم الأدمن - الإحصائيات العامة
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const requestsSnapshot = await db.collection('requests').get();
    const transactionsSnapshot = await db.collection('transactions').get();
    
    const users = usersSnapshot.docs.map(doc => doc.data());
    const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);
    const totalReferralEarnings = users.reduce((sum, u) => sum + (u.referralEarnings || 0), 0);
    const pendingRequests = requestsSnapshot.docs.filter(d => d.data().status === 'pending').length;
    const totalUsers = usersSnapshot.size;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newToday = users.filter(u => u.createdAt?.toDate() > today).length;
    
    res.json({
      success: true,
      stats: {
        totalUsers,
        newToday,
        totalBalance,
        totalReferralEarnings,
        pendingRequests,
        totalRequests: requestsSnapshot.size,
        totalTransactions: transactionsSnapshot.size
      }
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// جلب جميع المستخدمين مع ترقيم
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    let query = db.collection('users').orderBy('createdAt', 'desc');
    
    const snapshot = await query.get();
    let users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }));
    
    if (search) {
      users = users.filter(u => 
        u.email?.toLowerCase().includes(search.toLowerCase()) ||
        u.name?.toLowerCase().includes(search.toLowerCase()) ||
        u.uniqueId?.includes(search)
      );
    }
    
    const start = (page - 1) * limit;
    const paginatedUsers = users.slice(start, start + limit);
    
    res.json({
      success: true,
      users: paginatedUsers,
      total: users.length,
      page: Number(page),
      totalPages: Math.ceil(users.length / limit)
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
  }
});

// جلب مستخدم محدد
app.get('/api/admin/users/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    
    const requests = await db.collection('requests')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    
    const transactions = await db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    
    res.json({
      success: true,
      user: { id: userId, ...userDoc.data() },
      requests: requests.docs.map(d => ({ id: d.id, ...d.data() })),
      transactions: transactions.docs.map(t => ({ id: t.id, ...t.data() }))
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// تحديث رصيد المستخدم (يدوي)
app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  try {
    const { userId, amount, reason, type = 'manual' } = req.body;
    
    if (!userId || amount === undefined || amount === 0) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    
    const currentBalance = userDoc.data().balance || 0;
    const newBalance = currentBalance + Number(amount);
    
    await userRef.update({
      balance: newBalance,
      ...(amount > 0 ? { totalDeposited: admin.firestore.FieldValue.increment(amount) } : { totalWithdrawn: admin.firestore.FieldValue.increment(Math.abs(amount)) })
    });
    
    await db.collection('adminLogs').add({
      adminEmail: req.user.email,
      userId,
      action: 'update_balance',
      amount: Number(amount),
      previousBalance: currentBalance,
      newBalance,
      reason: reason || 'تعديل يدوي',
      type,
      timestamp: new Date()
    });
    
    await db.collection('transactions').add({
      userId,
      type: 'admin_adjustment',
      amount: Number(amount),
      previousBalance: currentBalance,
      newBalance,
      description: reason,
      createdAt: new Date()
    });
    
    res.json({ success: true, newBalance });
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'فشل تحديث الرصيد' });
  }
});

// الموافقة على طلب أو رفضه
app.post('/api/admin/process-request', requireAdmin, async (req, res) => {
  try {
    const { requestId, action, adminNotes } = req.body;
    
    if (!requestId || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'بيانات غير صالحة' });
    }
    
    const requestRef = db.collection('requests').doc(requestId);
    const requestDoc = await requestRef.get();
    
    if (!requestDoc.exists) return res.status(404).json({ error: 'طلب غير موجود' });
    
    const request = requestDoc.data();
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً' });
    }
    
    const userRef = db.collection('users').doc(request.userId);
    const userDoc = await userRef.get();
    
    if (action === 'approve') {
      if (request.type === 'withdraw') {
        if (userDoc.data().balance < request.amount) {
          return res.status(400).json({ error: 'الرصيد غير كافٍ' });
        }
        await userRef.update({
          balance: admin.firestore.FieldValue.increment(-request.amount),
          totalWithdrawn: admin.firestore.FieldValue.increment(request.amount)
        });
      } else if (request.type === 'deposit') {
        await userRef.update({
          balance: admin.firestore.FieldValue.increment(request.amount),
          totalDeposited: admin.firestore.FieldValue.increment(request.amount)
        });
      }
    }
    
    await requestRef.update({
      status: action === 'approve' ? 'approved' : 'rejected',
      processedAt: new Date(),
      processedBy: req.user.email,
      adminNotes: adminNotes || ''
    });
    
    await db.collection('transactions').add({
      userId: request.userId,
      type: `${request.type}_${action}`,
      amount: request.amount,
      requestId,
      status: action === 'approve' ? 'completed' : 'rejected',
      processedBy: req.user.email,
      createdAt: new Date()
    });
    
    await db.collection('adminLogs').add({
      adminEmail: req.user.email,
      action: `request_${action}`,
      requestId,
      userId: request.userId,
      amount: request.amount,
      timestamp: new Date()
    });
    
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب بنجاح` });
  } catch (error) {
    console.error('Process request error:', error);
    res.status(500).json({ error: 'فشل معالجة الطلب' });
  }
});

// جلب جميع الطلبات (للأدمن)
app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 20 } = req.query;
    let query = db.collection('requests').orderBy('createdAt', 'desc');
    
    let snapshot = await query.get();
    let requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }));
    
    if (status && status !== 'all') {
      requests = requests.filter(r => r.status === status);
    }
    if (type && type !== 'all') {
      requests = requests.filter(r => r.type === type);
    }
    
    const start = (page - 1) * limit;
    const paginated = requests.slice(start, start + limit);
    
    // جلب بيانات المستخدمين لكل طلب
    const requestsWithUser = await Promise.all(paginated.map(async (req) => {
      const userDoc = await db.collection('users').doc(req.userId).get();
      return { ...req, user: userDoc.exists ? userDoc.data() : null };
    }));
    
    res.json({
      success: true,
      requests: requestsWithUser,
      total: requests.length,
      page: Number(page),
      totalPages: Math.ceil(requests.length / limit)
    });
  } catch (error) {
    console.error('Admin requests error:', error);
    res.status(500).json({ error: 'خطأ في جلب الطلبات' });
  }
});

// حظر أو إلغاء حظر مستخدم
app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  try {
    const { userId, reason } = req.body;
    
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    
    const currentBan = userDoc.data().isBanned || false;
    await userRef.update({ isBanned: !currentBan });
    
    await db.collection('adminLogs').add({
      adminEmail: req.user.email,
      action: currentBan ? 'unban' : 'ban',
      userId,
      reason: reason || '',
      timestamp: new Date()
    });
    
    res.json({ success: true, isBanned: !currentBan });
  } catch (error) {
    res.status(500).json({ error: 'فشل تحديث حالة الحظر' });
  }
});

// إضافة أو تعديل إعدادات النظام
app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'مطلوب اسم الإعداد' });
    
    await db.collection('settings').doc(key).set({ value, updatedAt: new Date(), updatedBy: req.user.email });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'فشل حفظ الإعدادات' });
  }
});

app.get('/api/admin/settings/:key', requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc(req.params.key).get();
    res.json({ success: true, value: doc.exists ? doc.data().value : null });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// سجل عمليات الأدمن
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = await db.collection('adminLogs')
      .orderBy('timestamp', 'desc')
      .limit(Number(limit))
      .get();
    
    res.json({ success: true, logs: logs.docs.map(d => ({ id: d.id, ...d.data(), timestamp: d.data().timestamp?.toDate() })) });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin email: sam55nam@gmail.com`);
});
