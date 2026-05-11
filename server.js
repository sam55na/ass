import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');

// نظام إدارة المتغيرات
function loadEnvFile() {
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const envVars = {};
        envContent.split('\n').forEach(line => {
            const [key, ...valueParts] = line.split('=');
            if (key && valueParts.length) {
                envVars[key.trim()] = valueParts.join('=').trim();
            }
        });
        return envVars;
    }
    return {};
}

function saveEnvFile(envVars) {
    let content = '';
    for (const [key, value] of Object.entries(envVars)) {
        content += `${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    console.log('✅ تم حفظ الإعدادات');
}

async function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(query, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

async function setupFirebaseConfig() {
    console.log('\n🔐 إعداد Firebase:\n');
    const config = {
        FIREBASE_PRIVATE_KEY_ID: await askQuestion('private_key_id: '),
        FIREBASE_PRIVATE_KEY: await askQuestion('private_key: '),
        FIREBASE_CLIENT_EMAIL: await askQuestion('client_email: '),
        FIREBASE_CLIENT_ID: await askQuestion('client_id: '),
        FIREBASE_CERT_URL: await askQuestion('client_x509_cert_url: ')
    };
    saveEnvFile(config);
    return config;
}

async function initFirebase() {
    let envVars = loadEnvFile();
    
    if (!envVars.FIREBASE_PRIVATE_KEY_ID) {
        console.log('⚠️ لا توجد بيانات Firebase');
        const answer = await askQuestion('هل تريد إدخال البيانات الآن؟ (y/n): ');
        if (answer.toLowerCase() === 'y') {
            envVars = await setupFirebaseConfig();
        } else {
            console.log('❌ لا يمكن تشغيل الخادم');
            process.exit(1);
        }
    }
    
    const serviceAccount = {
        project_id: "boomb-fa3e7",
        private_key_id: envVars.FIREBASE_PRIVATE_KEY_ID,
        private_key: envVars.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: envVars.FIREBASE_CLIENT_EMAIL,
        client_id: envVars.FIREBASE_CLIENT_ID,
        client_x509_cert_url: envVars.FIREBASE_CERT_URL
    };
    
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase initialized');
    return admin.firestore();
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// دوال مساعدة
function generateUniqueId() {
    return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

const isAdmin = (email) => email === 'sam55nam@gmail.com';

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

// الـ APIs (نفس الكود السابق)
app.post('/api/user/register', requireAuth, async (req, res) => {
    try {
        const { uid, email, name, picture } = req.user;
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
            return res.json({ success: true, user: userDoc.data() });
        }
        
        const newUser = {
            uniqueId: generateUniqueId(),
            email,
            name: name || email.split('@')[0],
            photoURL: picture || null,
            balance: 0,
            referralEarnings: 0,
            referredBy: null,
            referrals: [],
            createdAt: new Date()
        };
        
        await userRef.set(newUser);
        res.json({ success: true, user: newUser });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/profile', requireAuth, async (req, res) => {
    try {
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        res.json({ success: true, user: userDoc.data() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/stats', requireAuth, async (req, res) => {
    try {
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        const data = userDoc.data();
        res.json({
            success: true,
            stats: {
                referralCount: data?.referrals?.length || 0,
                totalReferralEarnings: data?.referralEarnings || 0,
                balance: data?.balance || 0,
                uniqueId: data?.uniqueId
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/requests', requireAuth, async (req, res) => {
    try {
        const requests = await db.collection('requests')
            .where('userId', '==', req.user.uid)
            .orderBy('createdAt', 'desc')
            .limit(5)
            .get();
        res.json({ success: true, requests: requests.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/create-request', requireAuth, async (req, res) => {
    try {
        const { type, amount } = req.body;
        const request = {
            userId: req.user.uid,
            type,
            amount: Number(amount),
            status: 'pending',
            createdAt: new Date()
        };
        const docRef = await db.collection('requests').add(request);
        res.json({ success: true, requestId: docRef.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

let db;
async function startServer() {
    db = await initFirebase();
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
}

startServer();
