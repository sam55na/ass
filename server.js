// ============================================
// BOOMB - الخادم الكامل (Server)
// ============================================

import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';
import NodeCache from 'node-cache';
import crypto from 'crypto';

// ============================================
// الإعدادات الأساسية
// ============================================

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
const PORT = process.env.PORT || 3001;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@boomb.com';
const SPIN_COOLDOWN_SECONDS = 86400; // 24 ساعة

// ============================================
// ذاكرة التخزين المؤقت (Cache)
// ============================================

const userCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const settingsCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
const pendingRequests = new Map();

// ============================================
// Middleware
// ============================================

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
}));

app.use(compression({ level: 6, threshold: 1024 }));

app.use(cors({
    origin: [
        "https://sam55na.github.io",
        'http://localhost:3000',
        'http://localhost:5500',
        "https://*.onrender.com"
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Idempotency-Key'],
    maxAge: 86400
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress
});
app.use('/api/', limiter);

const spinLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.user?.uid || req.headers['x-forwarded-for']
});

// ============================================
// التوثيق (Authentication)
// ============================================

async function requireAuth(req, res, next) {
    try {
        const token = req.headers.authorization?.split('Bearer ')[1];
        if (!token) {
            return res.status(401).json({ error: 'غير مصرح: لا يوجد رمز توثيق' });
        }
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Auth error:', error);
        return res.status(401).json({ error: 'غير مصرح: رمز غير صالح' });
    }
}

async function requireAdmin(req, res, next) {
    if (req.user?.email !== ADMIN_EMAIL) {
        return res.status(403).json({ error: 'غير مصرح: هذه الخاصية للمدير فقط' });
    }
    next();
}

// ============================================
// القفل الموزع (Distributed Lock)
// ============================================

class DistributedLock {
    constructor(resource, ttl = 30) {
        this.resource = resource;
        this.ttl = ttl;
        this.lockId = crypto.randomBytes(16).toString('hex');
    }

    async acquire() {
        const lockRef = db.collection('locks').doc(this.resource);
        const now = Date.now();
        const expireAt = now + this.ttl * 1000;

        try {
            await db.runTransaction(async (t) => {
                const doc = await t.get(lockRef);
                if (doc.exists && doc.data().expiresAt > now) {
                    throw new Error('LOCK_ACQUIRED_BY_OTHER');
                }
                t.set(lockRef, {
                    expiresAt: expireAt,
                    lockId: this.lockId,
                    createdAt: new Date()
                });
            });
            return true;
        } catch (error) {
            if (error.message === 'LOCK_ACQUIRED_BY_OTHER') return false;
            throw error;
        }
    }

    async release() {
        const lockRef = db.collection('locks').doc(this.resource);
        const doc = await lockRef.get();
        if (doc.exists && doc.data().lockId === this.lockId) {
            await lockRef.delete();
        }
    }
}

// ============================================
// الإعدادات الافتراضية للعجلة
// ============================================

const DEFAULT_WHEEL_CONFIG = {
    sectors: [
        { name: "حظ أوفر", value: 0, probability: 40, gradientFrom: "#FFD700", gradientTo: "#FFA500" },
        { name: "10 SYP", value: 10, probability: 10, gradientFrom: "#1E90FF", gradientTo: "#0066CC" },
        { name: "20 SYP", value: 20, probability: 5, gradientFrom: "#1E90FF", gradientTo: "#0066CC" },
        { name: "30 SYP", value: 30, probability: 5, gradientFrom: "#1E90FF", gradientTo: "#0066CC" },
        { name: "حظ أوفر", value: 0, probability: 40, gradientFrom: "#FFD700", gradientTo: "#FFA500" },
        { name: "10 SYP", value: 10, probability: 10, gradientFrom: "#1E90FF", gradientTo: "#0066CC" },
        { name: "20 SYP", value: 20, probability: 5, gradientFrom: "#1E90FF", gradientTo: "#0066CC" },
        { name: "30 SYP", value: 30, probability: 5, gradientFrom: "#1E90FF", gradientTo: "#0066CC" }
    ],
    wheelSpinCost: 50
};

const DEFAULT_SETTINGS = {
    minDeposit: 10,
    minWithdraw: 100,
    usdToSypRate: 13000,
    referralCommission: 5,
    siteTheme: 'red',
    siteName: 'BOOMB',
    maintenanceMode: false,
    gameImageUrl: '',
    shamCashEnabled: false,
    shamCashApiKey: '',
    shamCashPrivateAddress: '',
    shamCashPublicAddress: '',
    shamCashUsdEnabled: false,
    shamCashUsdApiKey: '',
    shamCashUsdPrivateAddress: '',
    shamCashUsdPublicAddress: '',
    syriatelEnabled: false,
    syriatelApiKey: '',
    syriatelPrivateAddress: '',
    syriatelPublicAddress: '0930000000',
    ...DEFAULT_WHEEL_CONFIG
};

// ============================================
// جلب الإعدادات مع Cache
// ============================================

async function getSettings() {
    let settings = settingsCache.get('settings');
    if (settings) return settings;

    try {
        const settingsDoc = await db.collection('settings').doc('config').get();

        if (!settingsDoc.exists) {
            await db.collection('settings').doc('config').set(DEFAULT_SETTINGS);
            settingsCache.set('settings', DEFAULT_SETTINGS);
            return DEFAULT_SETTINGS;
        }

        settings = { ...DEFAULT_SETTINGS, ...settingsDoc.data() };
        settingsCache.set('settings', settings);
        return settings;
    } catch (error) {
        console.error('Error getting settings:', error);
        throw error;
    }
}

// ============================================
// توليد كود إحالة فريد
// ============================================

async function generateUniqueReferralCode() {
    let unique = false;
    let code = '';

    while (!unique) {
        code = 'BOOMB' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const existing = await db.collection('users').where('uniqueId', '==', code).get();
        if (existing.empty) unique = true;
    }
    return code;
}

// ============================================
// كلاس شام كاش
// ============================================

class ShamCashClient {
    constructor(apiKey, accountAddress) {
        this.apiKey = apiKey;
        this.accountAddress = accountAddress;
        this.baseUrl = "https://apisyria.com/api/v1";
    }

    async verifyTransaction(txid, expectedAmount = null, expectedCurrency = null) {
        if (!this.apiKey || !this.accountAddress) {
            return { success: false, message: "شام كاش غير مفعل" };
        }

        try {
            const params = {
                resource: "shamcash",
                action: "logs",
                account_address: this.accountAddress,
                api_key: this.apiKey
            };

            const response = await axios.get(this.baseUrl, { params, timeout: 15000 });

            if (response.status === 200 && response.data.success) {
                const items = response.data.data?.items || [];

                for (const item of items) {
                    if (String(item.tran_id) === String(txid)) {
                        const apiAmount = parseFloat(item.amount);
                        const apiCurrency = item.currency || 'SYP';
                        const timestamp = item.created_at || Date.now() / 1000;

                        if ((Date.now() / 1000 - timestamp) > 86400) {
                            return { success: false, message: "المعاملة قديمة (أكثر من 24 ساعة)" };
                        }

                        if (expectedCurrency && apiCurrency !== expectedCurrency) {
                            return { success: false, message: `عملة غير متطابقة: ${apiCurrency}` };
                        }

                        if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
                            return { success: false, message: `المبلغ غير متطابق: ${apiAmount}` };
                        }

                        return { success: true, amount: apiAmount, currency: apiCurrency };
                    }
                }
                return { success: false, message: "المعاملة غير موجودة" };
            }
            return { success: false, message: "فشل الاتصال بشام كاش" };
        } catch (error) {
            console.error('ShamCash error:', error);
            return { success: false, message: "خطأ في الاتصال بشام كاش" };
        }
    }
}

// ============================================
// API: التحقق من حالة العجلة
// ============================================

app.get('/api/user/wheel-status', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        let userData = userCache.get(`user_${uid}`);

        if (!userData) {
            const userDoc = await db.collection('users').doc(uid).get();
            if (!userDoc.exists) {
                return res.status(404).json({ error: 'مستخدم غير موجود' });
            }
            userData = userDoc.data();
            userCache.set(`user_${uid}`, userData);
        }

        const settings = await getSettings();
        const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
        const now = new Date();
        let canSpin = true;
        let remainingSeconds = 0;

        if (lastSpin) {
            const timeDiff = (now - lastSpin) / 1000;
            if (timeDiff < SPIN_COOLDOWN_SECONDS) {
                canSpin = false;
                remainingSeconds = Math.ceil(SPIN_COOLDOWN_SECONDS - timeDiff);
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

// ============================================
// API: تنفيذ التدوير (مع النسب المئوية)
// ============================================

app.post('/api/user/spin-wheel', requireAuth, spinLimiter, async (req, res) => {
    const { uid } = req.user;
    const lock = new DistributedLock(`spin:${uid}`, 20);

    if (!(await lock.acquire())) {
        return res.status(429).json({ error: 'هناك عملية تدوير أخرى قيد التنفيذ' });
    }

    try {
        const settings = await getSettings();
        const sectors = settings.sectors;
        const spinCost = settings.wheelSpinCost || 50;

        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            await lock.release();
            return res.status(404).json({ error: 'مستخدم غير موجود' });
        }

        const userData = userDoc.data();

        if ((userData.referralBalance || 0) < spinCost) {
            await lock.release();
            return res.status(400).json({ error: `رصيد الإحالات غير كافٍ. تحتاج ${spinCost} SYP` });
        }

        const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
        if (lastSpin && (Date.now() - lastSpin.getTime()) / 1000 < SPIN_COOLDOWN_SECONDS) {
            await lock.release();
            return res.status(429).json({ error: 'يجب الانتظار قبل التدوير مرة أخرى' });
        }

        // اختيار الجائزة بناءً على النسب المئوية
        const random = Math.random() * 100;
        let cumulativeProbability = 0;
        let selectedSectorIndex = 0;

        for (let i = 0; i < sectors.length; i++) {
            cumulativeProbability += sectors[i].probability;
            if (random <= cumulativeProbability) {
                selectedSectorIndex = i;
                break;
            }
        }

        const selectedSector = sectors[selectedSectorIndex];
        const prizeValue = selectedSector.value;

        const updateData = {
            lastSpinTime: admin.firestore.FieldValue.serverTimestamp(),
            totalSpins: admin.firestore.FieldValue.increment(1),
            referralBalance: admin.firestore.FieldValue.increment(-spinCost)
        };

        let message = '';
        if (prizeValue > 0) {
            updateData.balance = admin.firestore.FieldValue.increment(prizeValue);
            updateData.totalWinnings = admin.firestore.FieldValue.increment(prizeValue);
            message = `🎉 تهانينا! ربحت ${prizeValue} SYP!`;
        } else {
            message = `😢 حظ أوفر! لم تربح هذه المرة.`;
        }

        await userRef.update(updateData);

        await db.collection('wheel_history').add({
            userId: uid,
            sectorIndex: selectedSectorIndex,
            prizeName: selectedSector.name,
            prizeValue: prizeValue,
            spinCost: spinCost,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        userCache.del(`user_${uid}`);
        await lock.release();

        res.json({
            success: true,
            sector: selectedSectorIndex,
            prizeName: selectedSector.name,
            prizeAmount: prizeValue,
            message: message
        });
    } catch (error) {
        console.error('Spin error:', error);
        await lock.release();
        res.status(500).json({ error: 'حدث خطأ أثناء التدوير' });
    }
});

// ============================================
// API: تسجيل مستخدم جديد
// ============================================

app.post('/api/user/register', requireAuth, async (req, res) => {
    try {
        const { uid, email, name } = req.user;
        const { referrerId } = req.body;

        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
            return res.json({
                success: true,
                user: userDoc.data(),
                isAdmin: email === ADMIN_EMAIL
            });
        }

        const uniqueId = await generateUniqueReferralCode();
        let referredBy = null;
        let referrerName = null;

        if (referrerId) {
            const refQuery = await db.collection('users')
                .where('uniqueId', '==', referrerId)
                .limit(1)
                .get();

            if (!refQuery.empty) {
                const referrerDoc = refQuery.docs[0];
                referredBy = referrerDoc.id;
                referrerName = referrerDoc.data().name;
                await referrerDoc.ref.update({
                    referralBalance: admin.firestore.FieldValue.increment(5),
                    referralEarnings: admin.firestore.FieldValue.increment(5),
                    referrals: admin.firestore.FieldValue.arrayUnion(uid)
                });
                userCache.del(`user_${referredBy}`);
            }
        }

        const newUser = {
            uniqueId: uniqueId,
            email: email,
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
        userCache.set(`user_${uid}`, newUser);

        res.json({
            success: true,
            user: newUser,
            isAdmin: email === ADMIN_EMAIL
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'حدث خطأ أثناء التسجيل' });
    }
});

// ============================================
// API: إضافة كود إحالة
// ============================================

app.post('/api/user/add-referrer', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const { referrerCode } = req.body;

        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }

        const userData = userDoc.data();

        if (userData.referredBy) {
            return res.status(400).json({ error: 'لديك مُحيل بالفعل' });
        }

        const refQuery = await db.collection('users')
            .where('uniqueId', '==', referrerCode.toUpperCase())
            .limit(1)
            .get();

        if (refQuery.empty) {
            return res.status(404).json({ error: 'الكود غير صالح' });
        }

        const referrerDoc = refQuery.docs[0];

        if (referrerDoc.id === uid) {
            return res.status(400).json({ error: 'لا يمكنك إحالة نفسك' });
        }

        await userDoc.ref.update({
            referredBy: referrerDoc.id,
            referredByName: referrerDoc.data().name
        });

        await referrerDoc.ref.update({
            referralBalance: admin.firestore.FieldValue.increment(5),
            referralEarnings: admin.firestore.FieldValue.increment(5),
            referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });

        userCache.del(`user_${uid}`);
        userCache.del(`user_${referrerDoc.id}`);

        res.json({ success: true, message: `تم إضافة المُحيل: ${referrerDoc.data().name}` });
    } catch (error) {
        console.error('Add referrer error:', error);
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: جلب بيانات المستخدم
// ============================================

app.get('/api/user/profile', requireAuth, async (req, res) => {
    try {
        const { uid, email } = req.user;
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: 'مستخدم غير موجود' });
        }

        const userData = userDoc.data();
        res.json({
            success: true,
            user: userData,
            isAdmin: email === ADMIN_EMAIL
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: إحصائيات المستخدم
// ============================================

app.get('/api/user/stats', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const userDoc = await db.collection('users').doc(uid).get();

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

// ============================================
// API: إعدادات الإيداع
// ============================================

app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({
            success: true,
            settings: {
                minDeposit: settings.minDeposit,
                minWithdraw: settings.minWithdraw,
                usdToSypRate: settings.usdToSypRate,
                referralCommission: settings.referralCommission,
                wheelSpinCost: settings.wheelSpinCost,
                gameImageUrl: settings.gameImageUrl,
                siteTheme: settings.siteTheme
            }
        });
    } catch (error) {
        console.error('Deposit settings error:', error);
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: طلب إيداع جديد
// ============================================

app.post('/api/user/deposit', requireAuth, async (req, res) => {
    const { uid } = req.user;
    const { amount, transactionId, method, currency } = req.body;
    const lock = new DistributedLock(`deposit:${uid}`, 30);

    if (!(await lock.acquire())) {
        return res.status(429).json({ error: 'يوجد طلب إيداع قيد المعالجة' });
    }

    try {
        const settings = await getSettings();

        if (amount < settings.minDeposit) {
            await lock.release();
            return res.status(400).json({ error: `الحد الأدنى للإيداع هو ${settings.minDeposit} SYP` });
        }

        const existingDeposit = await db.collection('deposits')
            .where('transactionId', '==', transactionId)
            .where('userId', '==', uid)
            .get();

        if (!existingDeposit.empty) {
            await lock.release();
            return res.status(400).json({ error: 'رقم المعاملة موجود مسبقاً' });
        }

        // التحقق من المعاملة عبر شام كاش إذا كان مفعلاً
        let verified = false;
        let actualAmount = amount;
        let verificationNote = '';

        if (currency === 'USD' && settings.shamCashUsdEnabled) {
            const shamCash = new ShamCashClient(settings.shamCashUsdApiKey, settings.shamCashUsdPrivateAddress);
            const verification = await shamCash.verifyTransaction(transactionId, amount, 'USD');

            if (verification.success) {
                verified = true;
                actualAmount = verification.amount * settings.usdToSypRate;
                verificationNote = `تم التحقق عبر شام كاش USD: ${verification.amount} USD = ${actualAmount} SYP`;
            } else {
                await lock.release();
                return res.status(400).json({ error: `فشل التحقق من المعاملة: ${verification.message}` });
            }
        } else if (method === 'shamcash_syp' && settings.shamCashEnabled) {
            const shamCash = new ShamCashClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
            const verification = await shamCash.verifyTransaction(transactionId, amount, 'SYP');

            if (verification.success) {
                verified = true;
                actualAmount = verification.amount;
                verificationNote = `تم التحقق عبر شام كاش SYP: ${actualAmount} SYP`;
            } else {
                await lock.release();
                return res.status(400).json({ error: `فشل التحقق من المعاملة: ${verification.message}` });
            }
        } else {
            verified = false;
            verificationNote = 'في انتظار التحقق اليدوي';
        }

        const depositData = {
            userId: uid,
            amount: actualAmount,
            originalAmount: amount,
            originalCurrency: currency || 'SYP',
            method: method,
            transactionId: transactionId,
            status: verified ? 'approved' : 'pending',
            verificationNote: verificationNote,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            verifiedAt: verified ? new Date() : null
        };

        await db.collection('deposits').add(depositData);

        if (verified) {
            await db.collection('users').doc(uid).update({
                balance: admin.firestore.FieldValue.increment(actualAmount),
                totalDeposited: admin.firestore.FieldValue.increment(actualAmount)
            });
            userCache.del(`user_${uid}`);
        }

        await lock.release();

        res.json({
            success: true,
            message: verified ? 'تم تأكيد الإيداع وإضافة الرصيد' : 'تم تقديم طلب الإيداع، سيتم مراجعته قريباً'
        });
    } catch (error) {
        console.error('Deposit error:', error);
        await lock.release();
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة الإيداع' });
    }
});

// ============================================
// API: جلب تاريخ الإيداعات
// ============================================

app.get('/api/user/deposits', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const deposits = await db.collection('deposits')
            .where('userId', '==', uid)
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

        const depositList = [];
        deposits.forEach(doc => {
            const data = doc.data();
            depositList.push({
                id: doc.id,
                amount: data.amount,
                originalAmount: data.originalAmount,
                originalCurrency: data.originalCurrency,
                method: data.method,
                transactionId: data.transactionId,
                status: data.status,
                createdAt: data.createdAt?.toDate(),
                verifiedAt: data.verifiedAt?.toDate()
            });
        });

        res.json({ success: true, deposits: depositList });
    } catch (error) {
        console.error('Get deposits error:', error);
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: طلب سحب جديد
// ============================================

app.post('/api/user/withdraw', requireAuth, async (req, res) => {
    const { uid } = req.user;
    const { amount, address, method } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'المبلغ غير صالح' });
    }

    if (!address) {
        return res.status(400).json({ error: 'عنوان السحب مطلوب' });
    }

    const lock = new DistributedLock(`withdraw:${uid}`, 30);

    if (!(await lock.acquire())) {
        return res.status(429).json({ error: 'يوجد طلب سحب قيد المعالجة' });
    }

    try {
        const settings = await getSettings();

        if (amount < settings.minWithdraw) {
            await lock.release();
            return res.status(400).json({ error: `الحد الأدنى للسحب هو ${settings.minWithdraw} SYP` });
        }

        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.data();

        if (!userData || userData.balance < amount) {
            await lock.release();
            return res.status(400).json({ error: `الرصيد غير كافٍ. رصيدك: ${userData?.balance || 0} SYP` });
        }

        // خصم الرصيد فوراً
        await userDoc.ref.update({
            balance: admin.firestore.FieldValue.increment(-amount),
            totalWithdrawn: admin.firestore.FieldValue.increment(amount)
        });

        userCache.del(`user_${uid}`);

        const withdrawRequest = {
            userId: uid,
            amount: amount,
            address: address,
            method: method || 'shamcash',
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('withdraw_requests').add(withdrawRequest);

        await lock.release();

        res.json({ success: true, message: 'تم تقديم طلب السحب، سيتم معالجته قريباً' });
    } catch (error) {
        console.error('Withdraw error:', error);
        await lock.release();
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة السحب' });
    }
});

// ============================================
// API: جلب طلبات السحب للمستخدم
// ============================================

app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const requests = await db.collection('withdraw_requests')
            .where('userId', '==', uid)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const requestList = [];
        requests.forEach(doc => {
            const data = doc.data();
            requestList.push({
                id: doc.id,
                amount: data.amount,
                address: data.address,
                method: data.method,
                status: data.status,
                createdAt: data.createdAt?.toDate(),
                processedAt: data.processedAt?.toDate()
            });
        });

        res.json({ success: true, requests: requestList });
    } catch (error) {
        console.error('Get withdraw requests error:', error);
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: إحصائيات المدير
// ============================================

app.get('/api/admin/dashboard', requireAuth, requireAdmin, async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').get();
        const depositsSnapshot = await db.collection('deposits').get();
        const withdrawsSnapshot = await db.collection('withdraw_requests').get();

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let newToday = 0;
        let totalBalance = 0;
        let totalDeposited = 0;
        let totalWithdrawn = 0;
        let pendingWithdrawals = 0;
        let totalSpins = 0;
        let totalWinnings = 0;

        usersSnapshot.forEach(doc => {
            const data = doc.data();
            totalBalance += data.balance || 0;

            if (data.createdAt?.toDate && data.createdAt.toDate() >= today) {
                newToday++;
            }

            totalSpins += data.totalSpins || 0;
            totalWinnings += data.totalWinnings || 0;
        });

        depositsSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.status === 'approved') {
                totalDeposited += data.amount || 0;
            }
        });

        withdrawsSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.status === 'approved') {
                totalWithdrawn += data.amount || 0;
            } else if (data.status === 'pending') {
                pendingWithdrawals++;
            }
        });

        res.json({
            success: true,
            stats: {
                totalUsers: usersSnapshot.size,
                newToday: newToday,
                totalBalance: totalBalance,
                totalDeposited: totalDeposited,
                totalWithdrawn: totalWithdrawn,
                pendingWithdrawals: pendingWithdrawals,
                totalSpins: totalSpins,
                totalWinnings: totalWinnings
            }
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: جلب طلبات السحب للمدير
// ============================================

app.get('/api/admin/withdraw-requests', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        let query = db.collection('withdraw_requests').orderBy('createdAt', 'desc');

        if (status && status !== 'all') {
            query = query.where('status', '==', status);
        }

        const snapshot = await query.limit(200).get();
        const requests = [];

        for (const doc of snapshot.docs) {
            const data = doc.data();
            const userDoc = await db.collection('users').doc(data.userId).get();
            const userData = userDoc.exists ? userDoc.data() : null;

            requests.push({
                id: doc.id,
                userId: data.userId,
                userEmail: userData?.email || 'غير معروف',
                userName: userData?.name || 'غير معروف',
                amount: data.amount,
                address: data.address,
                method: data.method,
                status: data.status,
                createdAt: data.createdAt?.toDate(),
                processedAt: data.processedAt?.toDate()
            });
        }

        res.json({ success: true, requests: requests });
    } catch (error) {
        console.error('Admin withdraw requests error:', error);
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: معالجة طلب سحب (موافقة/رفض)
// ============================================

app.post('/api/admin/process-withdraw', requireAuth, requireAdmin, async (req, res) => {
    const { requestId, action } = req.body;

    if (!requestId || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'بيانات غير صالحة' });
    }

    const lock = new DistributedLock(`withdraw_process:${requestId}`, 30);

    if (!(await lock.acquire())) {
        return res.status(429).json({ error: 'الطلب قيد المعالجة' });
    }

    try {
        const requestRef = db.collection('withdraw_requests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists) {
            await lock.release();
            return res.status(404).json({ error: 'الطلب غير موجود' });
        }

        const requestData = requestDoc.data();

        if (requestData.status !== 'pending') {
            await lock.release();
            return res.status(400).json({ error: `تمت معالجة هذا الطلب بالفعل (${requestData.status})` });
        }

        if (action === 'reject') {
            // إعادة الرصيد للمستخدم
            await db.collection('users').doc(requestData.userId).update({
                balance: admin.firestore.FieldValue.increment(requestData.amount)
            });

            await requestRef.update({
                status: 'rejected',
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                processedBy: req.user.email
            });

            userCache.del(`user_${requestData.userId}`);
            await lock.release();

            return res.json({ success: true, message: 'تم رفض الطلب وإعادة الرصيد' });
        }

        // approve - هنا يمكن إضافة منطق للتحويل الفعلي عبر API خارجي
        await requestRef.update({
            status: 'approved',
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedBy: req.user.email
        });

        await lock.release();

        res.json({ success: true, message: 'تمت الموافقة على الطلب' });
    } catch (error) {
        console.error('Process withdraw error:', error);
        await lock.release();
        res.status(500).json({ error: 'حدث خطأ' });
    }
});

// ============================================
// API: جلب إعدادات العجلة للمدير
// ============================================

app.get('/api/admin/wheel-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({
            success: true,
            wheelConfig: {
                sectors: settings.sectors,
                spinCost: settings.wheelSpinCost
            }
        });
    } catch (error) {
        console.error('Get wheel settings error:', error);
        res.status(500).json({ error: 'فشل في جلب إعدادات العجلة' });
    }
});

// ============================================
// API: تحديث إعدادات العجلة (مع النسب المئوية)
// ============================================

app.post('/api/admin/wheel-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { sectors, spinCost } = req.body;

        if (!sectors || !Array.isArray(sectors) || sectors.length !== 8) {
            return res.status(400).json({ error: 'بيانات القطاعات غير صالحة (يجب أن تكون 8 قطاعات)' });
        }

        // التحقق من صحة النسب (يجب أن يكون مجموعها 100)
        const totalProbability = sectors.reduce((sum, sector) => sum + (sector.probability || 0), 0);
        if (Math.abs(totalProbability - 100) > 0.01) {
            return res.status(400).json({ error: `مجموع النسب المئوية يجب أن يساوي 100% (المجموع الحالي: ${totalProbability}%)` });
        }

        // التحقق من صحة القطاعات
        for (const sector of sectors) {
            if (!sector.name || sector.value === undefined || sector.probability === undefined) {
                return res.status(400).json({ error: 'بيانات القطاع غير مكتملة' });
            }
            if (sector.probability < 0 || sector.probability > 100) {
                return res.status(400).json({ error: `النسبة المئوية للقطاع "${sector.name}" غير صالحة` });
            }
        }

        await db.collection('settings').doc('config').set({
            sectors: sectors,
            wheelSpinCost: spinCost
        }, { merge: true });

        // إبطال الكاش
        settingsCache.del('settings');

        res.json({ success: true, message: 'تم تحديث إعدادات العجلة بنجاح' });
    } catch (error) {
        console.error('Update wheel settings error:', error);
        res.status(500).json({ error: 'فشل في تحديث إعدادات العجلة' });
    }
});

// ============================================
// API: تحديث سعر التدويرة فقط
// ============================================

app.post('/api/admin/update-wheel-cost', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { cost } = req.body;

        if (!cost || cost < 10 || cost > 10000) {
            return res.status(400).json({ error: 'السعر غير صالح (يجب أن يكون بين 10 و 10000)' });
        }

        await db.collection('settings').doc('config').set({
            wheelSpinCost: cost
        }, { merge: true });

        settingsCache.del('settings');

        res.json({ success: true, message: 'تم تحديث سعر التدويرة بنجاح' });
    } catch (error) {
        console.error('Update wheel cost error:', error);
        res.status(500).json({ error: 'فشل في تحديث السعر' });
    }
});

// ============================================
// API: تحديث ثيم الموقع
// ============================================

app.post('/api/admin/update-theme', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { theme } = req.body;

        const validThemes = ['red', 'blue', 'green', 'purple', 'orange', 'pink', 'teal', 'indigo', 'cyan', 'amber'];
        if (!validThemes.includes(theme)) {
            return res.status(400).json({ error: 'لون غير صالح' });
        }

        await db.collection('settings').doc('config').set({
            siteTheme: theme
        }, { merge: true });

        settingsCache.del('settings');

        res.json({ success: true, message: 'تم تحديث لون الموقع بنجاح' });
    } catch (error) {
        console.error('Update theme error:', error);
        res.status(500).json({ error: 'فشل في تحديث اللون' });
    }
});

// ============================================
// API: جلب لون الموقع
// ============================================

app.get('/api/site-theme', async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({ success: true, theme: settings.siteTheme || 'red' });
    } catch (error) {
        console.error('Get theme error:', error);
        res.json({ success: true, theme: 'red' });
    }
});

// ============================================
// API: جلب كل الإعدادات للمدير
// ============================================

app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({ success: true, settings: settings });
    } catch (error) {
        console.error('Get admin settings error:', error);
        res.status(500).json({ error: 'فشل في جلب الإعدادات' });
    }
});

// ============================================
// API: حفظ جميع الإعدادات
// ============================================

app.post('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const newSettings = req.body;
        const currentSettings = await getSettings();

        const mergedSettings = {
            ...currentSettings,
            ...newSettings,
            // الحفاظ على إعدادات العجلة إذا لم يتم إرسالها
            sectors: newSettings.sectors || currentSettings.sectors,
            wheelSpinCost: newSettings.wheelSpinCost || currentSettings.wheelSpinCost
        };

        await db.collection('settings').doc('config').set(mergedSettings, { merge: true });
        settingsCache.del('settings');

        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
    } catch (error) {
        console.error('Save admin settings error:', error);
        res.status(500).json({ error: 'فشل في حفظ الإعدادات' });
    }
});

// ============================================
// API: جلب جميع المستخدمين للمدير
// ============================================

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').orderBy('createdAt', 'desc').limit(500).get();
        const users = [];

        for (const doc of usersSnapshot.docs) {
            const data = doc.data();
            users.push({
                id: doc.id,
                email: data.email,
                name: data.name,
                uniqueId: data.uniqueId,
                balance: data.balance || 0,
                referralBalance: data.referralBalance || 0,
                referralsCount: data.referrals?.length || 0,
                referredByName: data.referredByName,
                totalSpins: data.totalSpins || 0,
                isBanned: data.isBanned || false,
                createdAt: data.createdAt?.toDate()
            });
        }

        res.json({ success: true, users: users });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'فشل في جلب المستخدمين' });
    }
});

// ============================================
// API: تعديل رصيد مستخدم
// ============================================

app.post('/api/admin/edit-balance', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { userId, amount } = req.body;

        if (!userId || amount === undefined || isNaN(amount)) {
            return res.status(400).json({ error: 'بيانات غير صالحة' });
        }

        await db.collection('users').doc(userId).update({
            balance: admin.firestore.FieldValue.increment(amount)
        });

        userCache.del(`user_${userId}`);

        res.json({ success: true, message: `تم ${amount >= 0 ? 'إضافة' : 'خصم'} ${Math.abs(amount)} SYP بنجاح` });
    } catch (error) {
        console.error('Edit balance error:', error);
        res.status(500).json({ error: 'فشل في تعديل الرصيد' });
    }
});

// ============================================
// API: حظر/إلغاء حظر مستخدم
// ============================================

app.post('/api/admin/toggle-ban', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.body;

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }

        const currentBan = userDoc.data().isBanned || false;

        await db.collection('users').doc(userId).update({
            isBanned: !currentBan
        });

        userCache.del(`user_${userId}`);

        res.json({ success: true, message: `تم ${!currentBan ? 'حظر' : 'إلغاء حظر'} المستخدم بنجاح` });
    } catch (error) {
        console.error('Toggle ban error:', error);
        res.status(500).json({ error: 'فشل في تغيير حالة الحظر' });
    }
});

// ============================================
// API: إعادة تعيين قاعدة البيانات (للمدير فقط)
// ============================================

app.post('/api/admin/reset-database', requireAuth, requireAdmin, async (req, res) => {
    const { password } = req.body;
    const RESET_PASSWORD = process.env.RESET_PASSWORD || 'BOOMB_RESET_2024';

    if (password !== RESET_PASSWORD) {
        return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
    }

    try {
        // حذف مجموعات البيانات
        const collections = ['users', 'deposits', 'withdraw_requests', 'wheel_history', 'locks'];
        
        for (const collectionName of collections) {
            const snapshot = await db.collection(collectionName).get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
        }

        // إعادة تعيين الإعدادات
        await db.collection('settings').doc('config').set(DEFAULT_SETTINGS);
        
        // إبطال الكاش
        userCache.flush();
        settingsCache.del('settings');
        pendingRequests.clear();

        res.json({ success: true, message: 'تم إعادة تعيين قاعدة البيانات بنجاح' });
    } catch (error) {
        console.error('Reset database error:', error);
        res.status(500).json({ error: 'فشل في إعادة تعيين قاعدة البيانات' });
    }
});

// ============================================
// نقطة نهاية للتحقق من صحة الخادم (Health Check)
// ============================================

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// تشغيل الخادم
// ============================================

const server = app.listen(PORT, () => {
    console.log(`✅ BOOMB Server running on port ${PORT}`);
    console.log(`📍 Admin: ${ADMIN_EMAIL}`);
    console.log(`🎰 Wheel system ready with 8 sectors and probability-based rewards`);
    console.log(`⚡ Cache enabled | Transaction support | Distributed locking active`);
});

// ============================================
// إيقاف تشغيل نظيف (Graceful Shutdown)
// ============================================

process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, closing server gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
