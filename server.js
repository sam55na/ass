import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';

// ============== Firebase Admin Initialization ==============
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

// ============== Middleware ==============
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
}));

app.use(compression());
app.use(cors({
    origin: ["https://sam55na.github.io", "http://localhost:3000", "http://localhost:5500", "https://*.onrender.com"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============== Rate Limiting ==============
const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false
});

const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use("/api", generalLimiter);
app.use("/api/user/deposit", strictLimiter);
app.use("/api/user/withdraw", strictLimiter);
app.use("/api/user/register", strictLimiter);
app.use("/api/user/wheel-spin", strictLimiter);
app.use("/api/admin", generalLimiter);

// ============== Constants ==============
const RESET_PASSWORD = process.env.RESET_PASSWORD || '2613857';
const ADMIN_EMAIL = 'sam55nam@gmail.com';

// ============== Helper Functions ==============

// Generate unique referral code
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
        const existing = await db.collection('users').where('uniqueId', '=', uniqueId).limit(1).get();
        if (existing.empty) {
            isUnique = true;
        }
        attempts++;
    }
    return uniqueId;
}

// Get settings from database
async function getSettings() {
    try {
        const doc = await db.collection('settings').doc('config').get();
        if (doc.exists) {
            return doc.data();
        }
        
        const defaultSettings = {
            minDeposit: 1000,
            minWithdraw: 5000,
            shamCashEnabled: true,
            syriatelEnabled: true,
            shamCashUsdEnabled: false,
            usdToSypRate: 13000,
            referralCommission: 5,
            wheelSpinCost: 100,
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
            wheelSpinCost: 100,
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

// ============== Authentication Middleware ==============
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const token = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Auth error:', error);
        return res.status(401).json({ error: 'Invalid token' });
    }
}

async function requireAdmin(req, res, next) {
    await requireAuth(req, res, async () => {
        if (req.user.email !== ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

// ============== Referral Commission Function ==============
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
                await db.runTransaction(async (transaction) => {
                    const referrerDoc = await transaction.get(referrerRef);
                    const currentReferrerData = referrerDoc.data();
                    const newReferralBalance = (currentReferrerData.referralBalance || 0) + commissionAmount;
                    const newReferralEarnings = (currentReferrerData.referralEarnings || 0) + commissionAmount;
                    
                    transaction.update(referrerRef, {
                        referralBalance: newReferralBalance,
                        referralEarnings: newReferralEarnings
                    });
                });
                
                await db.collection('referral_commissions').add({
                    userId: userData.referredBy,
                    fromUserId: userId,
                    amount: commissionAmount,
                    depositAmount: depositAmount,
                    percentage: commissionPercent,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                console.log(`Added ${commissionAmount} SYP commission to ${userData.referredBy} from deposit ${depositAmount}`);
            }
        }
    } catch (error) {
        console.error('Add referral commission error:', error);
    }
}

// ============== ShamCash Client Classes ==============
class ShamCashClient {
    constructor(apiKey, gsmNumber) {
        this.apiKey = apiKey;
        this.gsmNumber = gsmNumber;
        this.baseUrl = "https://apisyria.com/api/v1";
    }
    
    async verifyTransaction(txid, expectedAmount = null) {
        try {
            const params = {
                api_key: this.apiKey,
                resource: "sham_cash",
                action: "find_tx",
                tx: txid,
                gsm: this.gsmNumber
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
            console.error(`ShamCash error:`, error.message);
        }
        
        return { success: false, message: "رقم العملية غير موجود" };
    }
}

class ShamCashUsdClient {
    constructor(apiKey, gsmNumber) {
        this.apiKey = apiKey;
        this.gsmNumber = gsmNumber;
        this.baseUrl = "https://apisyria.com/api/v1";
    }
    
    async verifyTransaction(txid, expectedAmount = null) {
        try {
            const params = {
                api_key: this.apiKey,
                resource: "sham_cash_usd",
                action: "find_tx",
                tx: txid,
                gsm: this.gsmNumber
            };
            
            const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
            
            if (response.status === 200 && response.data.success && response.data.data?.found) {
                const transaction = response.data.data.transaction || {};
                const apiAmount = parseFloat(transaction.amount || 0);
                
                if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
                    return { success: false, message: "المبلغ غير متطابق" };
                }
                
                return { success: true, amount: apiAmount, currency: "USD" };
            }
        } catch (error) {
            console.error(`ShamCash USD error:`, error.message);
        }
        
        return { success: false, message: "رقم العملية غير موجود" };
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

// ============== User APIs ==============

// Get site theme
app.get('/api/site-theme', async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({ success: true, theme: settings.siteTheme || 'red' });
    } catch (error) {
        console.error('Theme error:', error);
        res.json({ success: true, theme: 'red' });
    }
});

// Register user
app.post('/api/user/register', requireAuth, async (req, res) => {
    try {
        const { referrerId } = req.body;
        const userId = req.user.uid;
        const userEmail = req.user.email;
        const userName = req.user.name || req.user.email?.split('@')[0] || 'مستخدم';
        
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        
        if (doc.exists) {
            const userData = doc.data();
            return res.json({ 
                success: true, 
                user: userData,
                isAdmin: req.user.email === ADMIN_EMAIL
            });
        }
        
        let referredBy = null;
        let referredByName = null;
        let referrerInfo = null;
        
        if (referrerId) {
            const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
            if (!referrerQuery.empty) {
                const referrerDoc = referrerQuery.docs[0];
                referredBy = referrerDoc.id;
                referredByName = referrerDoc.data().name || referrerDoc.data().email;
                referrerInfo = {
                    id: referrerDoc.id,
                    name: referredByName,
                    uniqueId: referrerDoc.data().uniqueId
                };
                
                await db.collection('users').doc(referredBy).update({
                    referrals: admin.firestore.FieldValue.arrayUnion(userId),
                    referralCount: admin.firestore.FieldValue.increment(1)
                });
            }
        }
        
        const uniqueId = await generateUniqueReferralCode();
        const newUser = {
            email: userEmail,
            name: userName,
            userId: userId,
            uniqueId: uniqueId,
            balance: 0,
            referralBalance: 0,
            referralEarnings: 0,
            totalDeposited: 0,
            totalWithdrawn: 0,
            referredBy: referredBy,
            referredByName: referredByName,
            referrerInfo: referrerInfo,
            referrals: [],
            referralCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            isBanned: false,
            lastSpinTime: null,
            totalSpins: 0,
            totalWheelEarned: 0,
            lastSpinPrize: null,
            lastSpinResult: null
        };
        
        await userRef.set(newUser);
        
        res.json({ 
            success: true, 
            user: newUser,
            isAdmin: req.user.email === ADMIN_EMAIL
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'فشل التسجيل' });
    }
});

// Get user profile
app.get('/api/user/profile', requireAuth, async (req, res) => {
    try {
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'مستخدم غير موجود' });
        }
        res.json({ 
            success: true, 
            user: userDoc.data(),
            isAdmin: req.user.email === ADMIN_EMAIL
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'خطأ في جلب البيانات' });
    }
});

// Get user stats
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
                referrerInfo: referrerInfo
            },
            siteTheme: settings.siteTheme || 'red'
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
    }
});

// Get deposit settings
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
    try {
        const settings = await getSettings();
        
        const methods = [];
        
        if (settings.shamCashEnabled) {
            methods.push({
                id: 'sham_cash',
                name: 'شام كاش',
                icon: '💳',
                currency: 'SYP',
                address: settings.shamCashPublicAddress || '0930000000'
            });
        }
        
        if (settings.shamCashUsdEnabled) {
            methods.push({
                id: 'sham_cash_usd',
                name: 'شام كاش (دولار)',
                icon: '💵',
                currency: 'USD',
                address: settings.shamCashUsdPublicAddress || '0930000000'
            });
        }
        
        if (settings.syriatelEnabled) {
            methods.push({
                id: 'syriatel_cash',
                name: 'سيرياتيل كاش',
                icon: '📱',
                currency: 'SYP',
                address: settings.syriatelPublicAddress || '0930000000'
            });
        }
        
        res.json({
            success: true,
            settings: {
                minDeposit: settings.minDeposit,
                minWithdraw: settings.minWithdraw,
                usdToSypRate: settings.usdToSypRate,
                referralCommission: settings.referralCommission,
                gameImageUrl: settings.gameImageUrl || '',
                methods: methods
            }
        });
    } catch (error) {
        console.error('Deposit settings error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
    }
});

// Submit deposit
app.post('/api/user/deposit', requireAuth, async (req, res) => {
    try {
        const { method, amount, transactionId } = req.body;
        const uid = req.user.uid;
        const amountNum = Number(amount);
        
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ error: 'المبلغ غير صالح' });
        }
        
        const settings = await getSettings();
        
        if (amountNum < settings.minDeposit) {
            return res.status(400).json({ error: `الحد الأدنى للإيداع هو ${settings.minDeposit} SYP` });
        }
        
        let verification = null;
        let originalAmount = null;
        let originalCurrency = null;
        let finalAmountSYP = null;
        
        if (method === 'sham_cash') {
            if (!settings.shamCashEnabled || !settings.shamCashApiKey || !settings.shamCashPrivateAddress) {
                return res.status(400).json({ error: 'طريقة الدفع شام كاش غير مفعلة' });
            }
            
            const client = new ShamCashClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
            verification = await client.verifyTransaction(transactionId, amountNum);
            
            if (verification.success) {
                originalAmount = verification.amount;
                originalCurrency = verification.currency;
                finalAmountSYP = originalAmount;
            }
        } else if (method === 'sham_cash_usd') {
            if (!settings.shamCashUsdEnabled || !settings.shamCashUsdApiKey || !settings.shamCashUsdPrivateAddress) {
                return res.status(400).json({ error: 'طريقة الدفع شام كاش دوالر غير مفعلة' });
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
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            const currentData = userDoc.data();
            
            transaction.update(userRef, {
                balance: (currentData.balance || 0) + finalAmountSYP,
                totalDeposited: (currentData.totalDeposited || 0) + finalAmountSYP
            });
        });
        
        await db.collection('deposits').add({
            userId: uid,
            userEmail: req.user.email,
            amount: finalAmountSYP,
            originalAmount: originalAmount,
            originalCurrency: originalCurrency,
            method: method,
            transactionId: transactionId,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'verified'
        });
        
        await addReferralCommission(uid, finalAmountSYP);
        
        res.json({ success: true, message: `تم إيداع ${finalAmountSYP.toLocaleString()} SYP بنجاح` });
    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ error: 'فشل الإيداع' });
    }
});

// Get user deposits
app.get('/api/user/deposits', requireAuth, async (req, res) => {
    try {
        const snapshot = await db.collection('deposits')
            .where('userId', '==', req.user.uid)
            .orderBy('verifiedAt', 'desc')
            .limit(50)
            .get();
        
        const deposits = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            deposits.push({
                id: doc.id,
                amount: data.amount,
                originalAmount: data.originalAmount,
                originalCurrency: data.originalCurrency,
                method: data.method,
                transactionId: data.transactionId,
                verifiedAt: data.verifiedAt?.toDate ? data.verifiedAt.toDate() : new Date()
            });
        });
        
        res.json({ success: true, deposits });
    } catch (error) {
        console.error('Get deposits error:', error);
        res.json({ success: true, deposits: [] });
    }
});

// Submit withdrawal request
app.post('/api/user/withdraw', requireAuth, async (req, res) => {
    try {
        const { amount, address, method } = req.body;
        const amountNum = Number(amount);
        const uid = req.user.uid;
        
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ error: 'المبلغ غير صالح' });
        }
        
        const settings = await getSettings();
        
        if (amountNum < settings.minWithdraw) {
            return res.status(400).json({ error: `الحد الأدنى للسحب هو ${settings.minWithdraw} SYP` });
        }
        
        if (!address || address.trim() === '') {
            return res.status(400).json({ error: 'عنوان السحب مطلوب' });
        }
        
        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.data();
        
        if (!userData) {
            return res.status(404).json({ error: 'مستخدم غير موجود' });
        }
        
        if (userData.isBanned) {
            return res.status(403).json({ error: 'حسابك محظور. تواصل مع الدعم' });
        }
        
        if (amountNum > (userData.balance || 0)) {
            return res.status(400).json({ error: `رصيد غير كافٍ. رصيدك الحالي: ${(userData.balance || 0).toLocaleString()} SYP` });
        }
        
        await db.collection('users').doc(uid).update({
            balance: admin.firestore.FieldValue.increment(-amountNum),
            totalWithdrawn: admin.firestore.FieldValue.increment(amountNum)
        });
        
        await db.collection('withdraw_requests').add({
            userId: uid,
            userEmail: req.user.email,
            userName: userData.name,
            amount: amountNum,
            address: address,
            method: method || 'sham_cash',
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP` });
    } catch (error) {
        console.error('Withdraw error:', error);
        res.status(500).json({ error: 'فشل إنشاء طلب السحب' });
    }
});

// Get user withdrawal requests
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

// ============== Wheel of Fortune APIs ==============

// Get wheel data
app.get('/api/user/wheel-data', requireAuth, async (req, res) => {
    try {
        const settings = await getSettings();
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        const userData = userDoc.data();
        
        const spinCost = settings.wheelSpinCost || 100;
        const now = Date.now();
        let canSpin = false;
        let nextSpinIn = 0;
        
        if (userData?.lastSpinTime) {
            const lastSpin = userData.lastSpinTime.toDate ? userData.lastSpinTime.toDate().getTime() : userData.lastSpinTime;
            const timeDiff = now - lastSpin;
            if (timeDiff >= 300000) {
                canSpin = true;
            } else {
                canSpin = false;
                nextSpinIn = Math.ceil((300000 - timeDiff) / 1000);
            }
        } else {
            canSpin = true;
        }
        
        const hasEnoughReferralBalance = (userData?.referralBalance || 0) >= spinCost;
        
        const wheelData = {
            spinCost: spinCost,
            lastSpinTime: userData?.lastSpinTime || null,
            canSpin: canSpin && hasEnoughReferralBalance,
            hasEnoughReferralBalance: hasEnoughReferralBalance,
            referralBalance: userData?.referralBalance || 0,
            nextSpinIn: nextSpinIn,
            insufficientBalance: !hasEnoughReferralBalance && canSpin
        };
        
        res.json({ success: true, wheelData });
    } catch (error) {
        console.error('Wheel data error:', error);
        res.status(500).json({ error: 'فشل جلب بيانات العجلة' });
    }
});

// Perform wheel spin
app.post('/api/user/wheel-spin', requireAuth, async (req, res) => {
    try {
        const settings = await getSettings();
        const spinCost = settings.wheelSpinCost || 100;
        const userRef = db.collection('users').doc(req.user.uid);
        const userDoc = await userRef.get();
        const userData = userDoc.data();
        
        if (!userData) {
            return res.status(404).json({ error: 'مستخدم غير موجود' });
        }
        
        if (userData.isBanned) {
            return res.status(403).json({ error: 'حسابك محظور' });
        }
        
        const now = Date.now();
        if (userData.lastSpinTime) {
            const lastSpin = userData.lastSpinTime.toDate ? userData.lastSpinTime.toDate().getTime() : userData.lastSpinTime;
            const timeDiff = now - lastSpin;
            if (timeDiff < 300000) {
                const remainingSeconds = Math.ceil((300000 - timeDiff) / 1000);
                return res.status(400).json({ 
                    error: `يجب الانتظار ${Math.floor(remainingSeconds / 60)} دقيقة و ${remainingSeconds % 60} ثانية قبل التدوير مرة أخرى` 
                });
            }
        }
        
        const currentReferralBalance = userData.referralBalance || 0;
        if (currentReferralBalance < spinCost) {
            return res.status(400).json({ 
                error: `رصيد الإحالات غير كافٍ. تحتاج ${spinCost.toLocaleString()} SYP للتدوير` 
            });
        }
        
        const segments = [
            { id: 1, name: 'حظ أوفر', type: 'extra_luck', value: 0, probability: 40, icon: '🍀' },
            { id: 2, name: '10 رصيد أساسي', type: 'main_balance', value: 10, probability: 10, icon: '💰' },
            { id: 3, name: '20 رصيد أساسي', type: 'main_balance', value: 20, probability: 5, icon: '💰' },
            { id: 4, name: '30 رصيد أساسي', type: 'main_balance', value: 30, probability: 5, icon: '💰' },
            { id: 5, name: 'حظ أوفر', type: 'extra_luck', value: 0, probability: 40, icon: '🍀' },
            { id: 6, name: '10 رصيد أساسي', type: 'main_balance', value: 10, probability: 10, icon: '💰' },
            { id: 7, name: '20 رصيد أساسي', type: 'main_balance', value: 20, probability: 5, icon: '💰' },
            { id: 8, name: '30 رصيد أساسي', type: 'main_balance', value: 30, probability: 5, icon: '💰' }
        ];
        
        const totalProbability = segments.reduce((sum, seg) => sum + seg.probability, 0);
        let random = Math.random() * totalProbability;
        let selectedSegment = segments[0];
        let cumulative = 0;
        
        for (const segment of segments) {
            cumulative += segment.probability;
            if (random <= cumulative) {
                selectedSegment = segment;
                break;
            }
        }
        
        let prizeMessage = '';
        let prizeAmount = 0;
        
        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(userRef);
            const currentData = doc.data();
            
            let newMainBalance = currentData.balance || 0;
            let newReferralBalance = (currentData.referralBalance || 0) - spinCost;
            let newTotalEarned = currentData.totalWheelEarned || 0;
            
            if (selectedSegment.type === 'main_balance') {
                newMainBalance += selectedSegment.value;
                prizeAmount = selectedSegment.value;
                newTotalEarned += selectedSegment.value;
                prizeMessage = `🎉 ربحت ${selectedSegment.value.toLocaleString()} SYP رصيد أساسي! 🎉`;
            } else {
                prizeMessage = `🍀 حظ أوفر! لم تربح هذه المرة، جرب حظك مرة أخرى 🍀`;
                prizeAmount = 0;
            }
            
            transaction.update(userRef, {
                balance: newMainBalance,
                referralBalance: newReferralBalance,
                lastSpinTime: admin.firestore.FieldValue.serverTimestamp(),
                totalSpins: admin.firestore.FieldValue.increment(1),
                totalWheelEarned: newTotalEarned,
                lastSpinPrize: selectedSegment.type === 'main_balance' ? selectedSegment.value : null,
                lastSpinResult: selectedSegment.name
            });
        });
        
        await db.collection('wheel_history').add({
            userId: req.user.uid,
            userEmail: req.user.email,
            spinCost: spinCost,
            prizeType: selectedSegment.type,
            prizeAmount: selectedSegment.type === 'main_balance' ? selectedSegment.value : 0,
            prizeName: selectedSegment.name,
            result: selectedSegment.type === 'main_balance' ? 'win' : 'loss',
            spunAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        const updatedUserDoc = await userRef.get();
        const updatedData = updatedUserDoc.data();
        
        res.json({
            success: true,
            prize: {
                type: selectedSegment.type,
                amount: selectedSegment.type === 'main_balance' ? selectedSegment.value : 0,
                name: selectedSegment.name,
                icon: selectedSegment.icon,
                message: prizeMessage
            },
            segmentIndex: selectedSegment.id - 1,
            newReferralBalance: updatedData.referralBalance,
            newMainBalance: updatedData.balance
        });
        
    } catch (error) {
        console.error('Spin error:', error);
        res.status(500).json({ error: 'فشل تنفيذ التدوير' });
    }
});

// ============== Admin APIs ==============

// Get admin dashboard stats
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').get();
        let totalBalance = 0;
        
        usersSnapshot.forEach(doc => {
            const data = doc.data();
            totalBalance += data.balance || 0;
        });
        
        const totalDeposited = usersSnapshot.docs.reduce((s, u) => s + (u.data().totalDeposited || 0), 0);
        const totalWithdrawn = usersSnapshot.docs.reduce((s, u) => s + (u.data().totalWithdrawn || 0), 0);
        const totalReferralEarnings = usersSnapshot.docs.reduce((s, u) => s + (u.data().referralEarnings || 0), 0);
        
        const pendingSnapshot = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const newToday = usersSnapshot.docs.filter(u => {
            const data = u.data();
            if (!data.createdAt) return false;
            const date = data.createdAt.toDate ? data.createdAt.toDate() : data.createdAt;
            return date > today;
        }).length;
        
        const todayDepositsSnapshot = await db.collection('deposits')
            .where('verifiedAt', '>=', today)
            .get();
        const todayDeposits = todayDepositsSnapshot.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
        
        res.json({
            success: true,
            stats: {
                totalUsers: usersSnapshot.size,
                newToday: newToday,
                totalBalance: totalBalance,
                totalDeposited: totalDeposited,
                totalWithdrawn: totalWithdrawn,
                totalReferralEarnings: totalReferralEarnings,
                pendingWithdrawals: pendingSnapshot.size,
                todayDeposits: todayDeposits
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
    }
});

// Get all withdrawal requests (admin)
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
                userName: data.userName || (userDoc.exists ? userDoc.data().name : null),
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

// Process withdrawal (approve/reject)
app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
    try {
        const { requestId, action } = req.body;
        const requestRef = db.collection('withdraw_requests').doc(requestId);
        const requestDoc = await requestRef.get();
        
        if (!requestDoc.exists) {
            return res.status(404).json({ error: 'طلب غير موجود' });
        }
        
        const request = requestDoc.data();
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'تم معالجة هذا الطلب' });
        }
        
        if (action === 'reject') {
            await db.collection('users').doc(request.userId).update({
                balance: admin.firestore.FieldValue.increment(request.amount)
            });
        }
        
        await requestRef.update({
            status: action === 'approve' ? 'approved' : 'rejected',
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedBy: req.user.email
        });
        
        res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب` });
    } catch (error) {
        console.error('Process withdraw error:', error);
        res.status(500).json({ error: 'فشل معالجة الطلب' });
    }
});

// Get all deposits (admin)
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
                originalAmount: data.originalAmount,
                originalCurrency: data.originalCurrency,
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

// Get all users (admin)
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
                balance: data.balance || 0,
                referralBalance: data.referralBalance || 0,
                isBanned: data.isBanned || false,
                referredBy: data.referredBy,
                referredByName: data.referredByName,
                referralEarnings: data.referralEarnings || 0,
                referralsCount: data.referrals?.length || 0,
                totalSpins: data.totalSpins || 0,
                totalWheelEarned: data.totalWheelEarned || 0
            });
        });
        
        res.json({ success: true, users });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
    }
});

// Update user balance (admin)
app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
    try {
        const { userId, amount, reason } = req.body;
        
        await db.collection('users').doc(userId).update({
            balance: admin.firestore.FieldValue.increment(Number(amount))
        });
        
        await db.collection('admin_actions').add({
            userId: userId,
            action: 'update_balance',
            amount: Number(amount),
            reason: reason || 'تعديل يدوي',
            adminEmail: req.user.email,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update balance error:', error);
        res.status(500).json({ error: 'فشل تحديث الرصيد' });
    }
});

// Toggle user ban (admin)
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

// Get admin settings
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
    }
});

// Update admin settings
app.post('/api/admin/settings', requireAdmin, async (req, res) => {
    try {
        const settings = req.body;
        const settingsRef = db.collection('settings').doc('config');
        
        await settingsRef.update(settings);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ error: 'فشل تحديث الإعدادات' });
    }
});

// Update site theme (admin)
app.post('/api/admin/update-theme', requireAdmin, async (req, res) => {
    try {
        const { theme } = req.body;
        
        await db.collection('settings').doc('config').update({
            siteTheme: theme
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update theme error:', error);
        res.status(500).json({ error: 'فشل تحديث اللون' });
    }
});

// Update wheel settings (admin)
app.post('/api/admin/update-wheel-settings', requireAdmin, async (req, res) => {
    try {
        const { spinCost } = req.body;
        
        if (spinCost === undefined || spinCost < 1) {
            return res.status(400).json({ error: 'سعر التدويرة غير صالح' });
        }
        
        await db.collection('settings').doc('config').update({
            wheelSpinCost: spinCost
        });
        
        res.json({ success: true, message: `تم تحديث سعر التدويرة إلى ${spinCost.toLocaleString()} SYP` });
    } catch (error) {
        console.error('Update wheel settings error:', error);
        res.status(500).json({ error: 'فشل تحديث إعدادات العجلة' });
    }
});

// Get wheel history (admin)
app.get('/api/admin/wheel-history', requireAdmin, async (req, res) => {
    try {
        const { limit = 100, userId } = req.query;
        let query = db.collection('wheel_history').orderBy('spunAt', 'desc');
        
        if (userId) {
            query = query.where('userId', '==', userId);
        }
        
        const snapshot = await query.limit(parseInt(limit)).get();
        const history = [];
        
        for (const doc of snapshot.docs) {
            const data = doc.data();
            let userEmail = data.userEmail;
            
            if (!userEmail && data.userId) {
                const userDoc = await db.collection('users').doc(data.userId).get();
                if (userDoc.exists) {
                    userEmail = userDoc.data().email;
                }
            }
            
            history.push({
                id: doc.id,
                userId: data.userId,
                userEmail: userEmail,
                spinCost: data.spinCost,
                prizeType: data.prizeType,
                prizeAmount: data.prizeAmount,
                prizeName: data.prizeName,
                result: data.result,
                spunAt: data.spunAt?.toDate ? data.spunAt.toDate() : new Date()
            });
        }
        
        res.json({ success: true, history });
    } catch (error) {
        console.error('Wheel history error:', error);
        res.status(500).json({ error: 'فشل جلب تاريخ العجلة' });
    }
});

// Get wheel statistics (admin)
app.get('/api/admin/wheel-stats', requireAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection('wheel_history').get();
        
        let totalSpins = 0;
        let totalWins = 0;
        let totalLosses = 0;
        let totalWonAmount = 0;
        let totalSpentOnSpins = 0;
        
        snapshot.forEach(doc => {
            const data = doc.data();
            totalSpins++;
            if (data.result === 'win') {
                totalWins++;
                totalWonAmount += data.prizeAmount || 0;
            } else {
                totalLosses++;
            }
            totalSpentOnSpins += data.spinCost || 0;
        });
        
        const recentWinsSnapshot = await db.collection('wheel_history')
            .where('result', '==', 'win')
            .orderBy('spunAt', 'desc')
            .limit(10)
            .get();
        
        const recentWinners = [];
        for (const doc of recentWinsSnapshot.docs) {
            const data = doc.data();
            let userEmail = data.userEmail;
            if (!userEmail && data.userId) {
                const userDoc = await db.collection('users').doc(data.userId).get();
                if (userDoc.exists) {
                    userEmail = userDoc.data().email;
                }
            }
            recentWinners.push({
                userEmail: userEmail || 'مستخدم',
                prizeAmount: data.prizeAmount,
                prizeName: data.prizeName,
                spunAt: data.spunAt?.toDate ? data.spunAt.toDate() : new Date()
            });
        }
        
        res.json({
            success: true,
            stats: {
                totalSpins,
                totalWins,
                totalLosses,
                winRate: totalSpins > 0 ? ((totalWins / totalSpins) * 100).toFixed(2) : 0,
                totalWonAmount,
                totalSpentOnSpins,
                netResult: totalWonAmount - totalSpentOnSpins,
                recentWinners
            }
        });
    } catch (error) {
        console.error('Wheel stats error:', error);
        res.status(500).json({ error: 'فشل جلب إحصائيات العجلة' });
    }
});

// Reset database (admin)
app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
    try {
        const { password } = req.body;
        
        if (password !== RESET_PASSWORD) {
            return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
        }
        
        const collections = ['users', 'withdraw_requests', 'deposits', 'referral_commissions', 'wheel_history', 'admin_actions'];
        
        for (const col of collections) {
            const snapshot = await db.collection(col).get();
            const deletions = [];
            snapshot.forEach(doc => deletions.push(db.collection(col).doc(doc.id).delete()));
            await Promise.all(deletions);
        }
        
        const defaultSettings = {
            minDeposit: 1000,
            minWithdraw: 5000,
            shamCashEnabled: true,
            syriatelEnabled: true,
            shamCashUsdEnabled: false,
            usdToSypRate: 13000,
            referralCommission: 5,
            wheelSpinCost: 100,
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
        
        res.json({ success: true, message: 'تم إعادة تعيين قاعدة البيانات بالكامل' });
    } catch (error) {
        console.error('Reset error:', error);
        res.status(500).json({ error: 'فشل إعادة تعيين قاعدة البيانات' });
    }
});

// Reset wheel data (admin)
app.post('/api/admin/reset-wheel-data', requireAdmin, async (req, res) => {
    try {
        const { password } = req.body;
        
        if (password !== RESET_PASSWORD) {
            return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
        }
        
        const historySnapshot = await db.collection('wheel_history').get();
        const deletions = [];
        historySnapshot.forEach(doc => deletions.push(db.collection('wheel_history').doc(doc.id).delete()));
        await Promise.all(deletions);
        
        const usersSnapshot = await db.collection('users').get();
        const userUpdates = [];
        usersSnapshot.forEach(doc => {
            userUpdates.push(db.collection('users').doc(doc.id).update({
                lastSpinTime: null,
                totalSpins: 0,
                totalWheelEarned: 0,
                lastSpinPrize: null,
                lastSpinResult: null
            }));
        });
        await Promise.all(userUpdates);
        
        res.json({ success: true, message: 'تم إعادة تعيين بيانات العجلة بالكامل' });
    } catch (error) {
        console.error('Reset wheel data error:', error);
        res.status(500).json({ error: 'فشل إعادة تعيين بيانات العجلة' });
    }
});

// ============== Start Server ==============
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🎡 BOOMB Server running on port ${PORT}`);
    console.log(`👑 Admin: ${ADMIN_EMAIL}`);
    console.log(`🎰 Wheel of Fortune enabled with 8 segments`);
});
