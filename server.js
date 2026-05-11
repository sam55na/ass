import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import session from 'express-session';
import rateLimit from 'express-rate-limit';

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

// ============= الإعدادات =============
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: 'boomb_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 60 * 60 * 1000 } // ساعة
}));

// منع التكرار (دقيقة)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'الرجاء الانتظار دقيقة قبل المحاولة مرة أخرى'
});
app.use('/api/', limiter);

// تخزين مؤقت لمنع تكرار العمليات
const actionCooldown = new Map();

function checkCooldown(userId, action) {
  const key = `${userId}:${action}`;
  const last = actionCooldown.get(key);
  const now = Date.now();
  if (last && (now - last) < 60000) {
    return { allowed: false, remaining: Math.ceil((60000 - (now - last)) / 1000) };
  }
  actionCooldown.set(key, now);
  return { allowed: true, remaining: 0 };
}

// ============= دوال مساعدة =============
function generateUniqueId() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

const isAdmin = (email) => email === 'sam55nam@gmail.com';

// التحقق من التوكن
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

// ============= APIs =============

// تسجيل/جلب المستخدم
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name, picture } = req.user;
    const { referrerId } = req.body;
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: isAdmin(email) });
    }
    
    // إنشاء مستخدم جديد
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
      referralEarnings: 0,
      referredBy: finalReferrer,
      referrals: [],
      createdAt: new Date(),
      lastActive: new Date(),
      isBanned: false
    };
    
    await userRef.set(newUser);
    
    // مكافأة الإحالة
    if (finalReferrer) {
      const refDoc = await db.collection('users').where('uniqueId', '==', finalReferrer).limit(1).get();
      if (!refDoc.empty) {
        await refDoc.docs[0].ref.update({
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
      }
    }
    
    res.json({ success: true, user: newUser, isAdmin: isAdmin(email) });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// جلب بيانات المستخدم
app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({ success: true, user: userDoc.data(), isAdmin: isAdmin(req.user.email) });
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
        balance: data.balance,
        uniqueId: data.uniqueId,
        joinDate: data.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// جلب آخر 5 طلبات
app.get('/api/user/requests', requireAuth, async (req, res) => {
  try {
    const requests = await db.collection('requests')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();
    
    res.json({
      success: true,
      requests: requests.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }))
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// إنشاء طلب (إيداع/سحب) - منع تكرار دقيقة
app.post('/api/user/create-request', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { type, amount } = req.body;
    
    if (!type || !amount || amount <= 0) {
      return res.status(400).json({ error: 'بيانات غير صالحة' });
    }
    
    // التحقق من منع التكرار
    const cooldown = checkCooldown(uid, 'request');
    if (!cooldown.allowed) {
      return res.status(429).json({ error: `انتظر ${cooldown.remaining} ثانية` });
    }
    
    const request = {
      userId: uid,
      type,
      amount: Number(amount),
      status: 'pending',
      createdAt: new Date()
    };
    
    const docRef = await db.collection('requests').add(request);
    res.json({ success: true, requestId: docRef.id });
  } catch (error) {
    res.status(500).json({ error: 'فشل إنشاء الطلب' });
  }
});

// لوحة الأدمن - جلب المستخدمين
app.get('/api/admin/users', requireAuth, async (req, res) => {
  if (!isAdmin(req.user.email)) return res.status(403).json({ error: 'غير مصرح' });
  
  const users = await db.collection('users').orderBy('createdAt', 'desc').limit(50).get();
  res.json({ success: true, users: users.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ خادم BOOMB يعمل على منفذ ${PORT}`));
