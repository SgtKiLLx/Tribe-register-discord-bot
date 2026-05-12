import express from 'express';
// Assuming you have a log array or database collection named 'intelLogs'
// and a collection for 'survivors'

const app = express();
const ADMIN_KEY = process.env.ADMIN_APP_KEY; // Set this in Render Dashboard

app.use(express.json());

// 1. REAL ACTIVITY FEED DATA
app.get('/api/intel', (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    
    // In your bot, pull the last 50 logs
    // Example: const logs = await db.logs.find().sort({timestamp: -1}).limit(50);
    res.json(logs); 
});

// 2. SURVIVOR DATA (For the Search Bar)
app.get('/api/survivors', (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    // Example: const survivors = await db.users.find();
    res.json(survivors);
});

app.listen(process.env.PORT || 3000);
