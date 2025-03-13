const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const fs = require('fs');
const WebSocket = require('ws');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Add WebSocket support - Move this up here
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        } else if (path.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
        }
    }
}));

// Add security headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Initialize Google Drive with service account
let drive;
let lastProcessedData = {
    lastFileId: null,
    lastRowCount: 0,
    lastModifiedTime: null
};
let serviceAccountCredentials;

// Add cache for sales data
let salesDataCache = {
    data: null,
    lastUpdated: null
};

async function initializeDrive() {
    try {
        // Store credentials in the top-level variable
        if (process.env.SERVICE_ACCOUNT_KEY) {
            console.log('Using service account from environment variable');
            serviceAccountCredentials = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
        } else {
            console.log('Using service account from local file');
            serviceAccountCredentials = require('./service-account-key.json');
        }

        if (!serviceAccountCredentials) {
            throw new Error('No service account credentials found');
        }

        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccountCredentials,
            scopes: [
                'https://www.googleapis.com/auth/drive.readonly',
                'https://www.googleapis.com/auth/drive.metadata.readonly'
            ]
        });

        const client = await auth.getClient();
        drive = google.drive({ 
            version: 'v3', 
            auth: client
        });
        
        await drive.files.list({ pageSize: 1 });
        console.log('Successfully initialized Google Drive API');
        return true;
    } catch (error) {
        console.error('Error initializing Drive API:', error.message);
        if (error.response) {
            console.error('API Response:', error.response.data);
        }
        return false;
    }
}

// Initialize drive when server starts
initializeDrive();

// Google Drive API Routes
app.get('/api/drive', (req, res) => {
    res.json({
        status: 'Google Drive API is running',
        endpoints: [
            '/api/drive/status',
            '/api/drive/folders',
            '/api/drive/files'
        ]
    });
});

app.get('/api/drive/folders', async (req, res) => {
    try {
        if (!drive) {
            const initialized = await initializeDrive();
            if (!initialized) {
                throw new Error('Failed to initialize Drive API');
            }
        }

        const foldersResponse = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.folder'",
            fields: 'files(id, name, modifiedTime)',
            orderBy: 'name'
        });

        let folderDetails = [];

        for (const folder of foldersResponse.data.files) {
            const filesResponse = await drive.files.list({
                q: `'${folder.id}' in parents and mimeType='text/csv' and name contains '_Orders_'`,
                fields: 'files(id, name, modifiedTime, size)',
                orderBy: 'name'
            });

            if (filesResponse.data.files.length > 0) {
                folderDetails.push({
                    folder: folder.name,
                    folderId: folder.id,
                    modifiedTime: folder.modifiedTime,
                    files: filesResponse.data.files
                });
            }
        }

        res.json({
            success: true,
            folders: folderDetails
        });

    } catch (error) {
        console.error('Error listing folders:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data || 'No additional details'
        });
    }
});

app.get('/api/drive/status', async (req, res) => {
    try {
        if (!drive) {
            await initializeDrive();
        }
        const response = await drive.files.list({ pageSize: 1 });
        res.json({ connected: true });
    } catch (error) {
        console.error('Status check error:', error);
        res.json({ connected: false, error: error.message });
    }
});

// Update the CSV parsing function
async function parseCSVFromDrive(fileId) {
    try {
        const response = await drive.files.get({
            fileId: fileId,
            alt: 'media'
        }, {
            responseType: 'text'
        });
        
        const rows = response.data.split('\n');
        if (rows.length < 2) {
            console.log('Empty or invalid CSV file');
            return { count: 0, sales: 0, guests: 0 };
        }

        let completedOrders = 0;
        let totalSales = 0;
        let totalGuests = 0;
        
        // Process each row (skipping header)
        for (let i = 1; i < rows.length; i++) {
            if (!rows[i].trim()) continue; // Skip empty lines
            
            const columns = rows[i].split(',');
            
            // Check conditions:
            // array[7] should be 1 (isFinished)
            // array[8] should be 0 (isCancelled)
            if (columns[7]?.trim() === '1' && 
                columns[8]?.trim() === '0') {
                
                completedOrders++;
                
                // Add sales amount from array[9]
                const amount = parseFloat(columns[9]?.trim()) || 0;
                totalSales += amount;
                
                // Add guest count from array[5]
                const guests = parseInt(columns[5]?.trim()) || 0;
                totalGuests += guests;
            }
        }
        
        console.log(`File ${fileId}:`);
        console.log(`- Found ${completedOrders} valid orders`);
        console.log(`- Total sales: PHP ${totalSales.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
        console.log(`- Total guests: ${totalGuests}`);
        
        return { count: completedOrders, sales: totalSales, guests: totalGuests };
    } catch (error) {
        console.error(`Error parsing CSV file ${fileId}:`, error);
        return { count: 0, sales: 0, guests: 0 };
    }
}

// Update the transaction count endpoint to include guest count
app.get('/api/transactions/count', async (req, res) => {
    try {
        if (!drive) {
            const initialized = await initializeDrive();
            if (!initialized) {
                throw new Error('Failed to initialize Drive API');
            }
        }

        const foldersResponse = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.folder'",
            fields: 'files(id, name)',
            orderBy: 'name'
        });

        console.log('\n=== Processing CSV Files ===');
        console.log(`Found ${foldersResponse.data.files.length} folders`);

        let totalTransactions = 0;
        let totalSalesAmount = 0;
        let totalGuestCount = 0;
        let processedFiles = [];
        let totalCsvFiles = 0;

        // Process each folder
        for (const folder of foldersResponse.data.files) {
            const response = await drive.files.list({
                q: `'${folder.id}' in parents and mimeType='text/csv'`,
                fields: 'files(id, name)',
                orderBy: 'name desc'
            });

            const csvCount = response.data.files.length;
            totalCsvFiles += csvCount;
            console.log(`\nFolder "${folder.name}":`);
            console.log(`- Contains ${csvCount} CSV files`);

            // Process each CSV file
            for (const file of response.data.files) {
                console.log(`\nProcessing: ${file.name}`);
                const result = await parseCSVFromDrive(file.id);
                
                totalTransactions += result.count;
                totalSalesAmount += result.sales;
                totalGuestCount += result.guests;
                
                processedFiles.push({
                    folder: folder.name,
                    file: file.name,
                    validOrders: result.count,
                    sales: result.sales,
                    guests: result.guests
                });
            }
        }

        console.log('\n=== Summary ===');
        console.log(`Total folders: ${foldersResponse.data.files.length}`);
        console.log(`Total CSV files: ${totalCsvFiles}`);
        console.log(`Total valid transactions: ${totalTransactions}`);
        console.log(`Total sales: PHP ${totalSalesAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
        console.log(`Total guests: ${totalGuestCount}`);
        console.log('================\n');

        res.json({ 
            count: totalTransactions,
            sales: totalSalesAmount,
            guests: totalGuestCount,
            success: true,
            summary: {
                folders: foldersResponse.data.files.length,
                csvFiles: totalCsvFiles,
                transactions: totalTransactions,
                totalSales: totalSalesAmount,
                totalGuests: totalGuestCount
            },
            details: processedFiles
        });
    } catch (error) {
        console.error('Error counting transactions:', error);
        res.status(500).json({ 
            error: 'Failed to count transactions', 
            details: error.message 
        });
    }
});

// Add login endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Get credentials from environment variables
    const validUsername = process.env.ADMIN_USERNAME;
    const validPassword = process.env.ADMIN_PASSWORD;

    console.log('Login attempt:', { 
        provided: { username, password },
        expected: { username: validUsername, password: validPassword }
    });

    if (username === validUsername && password === validPassword) {
        res.json({ 
            success: true, 
            username: username 
        });
    } else {
        res.status(401).json({ 
            success: false, 
            error: 'Invalid username or password' 
        });
    }
});

// Add authentication middleware for protected routes
const requireAuth = (req, res, next) => {
    // Add authentication check here if needed
    next();
};

// Protect dashboard route
app.get('/dashboard.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Update the catch-all route
app.get('*', (req, res, next) => {
    // Skip API routes
    if (req.url.startsWith('/api/')) return next();
    
    const filePath = path.join(__dirname, 'public', req.url);
    
    // Check file extension
    const ext = path.extname(req.url);
    
    if (ext === '.css') {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
    } else if (ext === '.js') {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Add route for files
app.get('/api/drive/files', async (req, res) => {
    try {
        if (!drive) {
            const initialized = await initializeDrive();
            if (!initialized) {
                throw new Error('Failed to initialize Drive API');
            }
        }

        const response = await drive.files.list({
            q: "mimeType='text/csv'",
            fields: 'files(id, name, mimeType, size, modifiedTime)',
            orderBy: 'modifiedTime desc'
        });

        res.json(response.data.files);
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// Modify the daily sales endpoint to use caching
app.get('/api/sales/daily', async (req, res, next) => {
    try {
        // Check if we have cached data and it's less than 5 minutes old
        const cacheAge = salesDataCache.lastUpdated ? Date.now() - salesDataCache.lastUpdated : Infinity;
        if (salesDataCache.data && cacheAge < 300000) { // 5 minutes
            console.log('Returning cached sales data');
            return res.json(salesDataCache.data);
        }

        if (!drive) {
            const initialized = await initializeDrive();
            if (!initialized) {
                throw new Error('Failed to initialize Drive API');
            }
        }

        // Get the most recent file's metadata first
        const latestFileResponse = await drive.files.list({
            q: "mimeType='text/csv' and name contains '_Orders_'",
            fields: 'files(id, modifiedTime)',
            orderBy: 'modifiedTime desc',
            pageSize: 1
        });

        // Check if we need to update
        if (latestFileResponse.data.files.length > 0) {
            const latestFile = latestFileResponse.data.files[0];
            if (lastProcessedData.lastFileId === latestFile.id && 
                lastProcessedData.lastModifiedTime === latestFile.modifiedTime &&
                salesDataCache.data) {
                console.log('No new changes, returning cached data');
                return res.json(salesDataCache.data);
            }
        }

        // If we reach here, we need to fetch new data
        console.log('Fetching fresh sales data...');

        // Get all CSV files that contain '_Orders_'
        const response = await drive.files.list({
            q: "mimeType='text/csv' and name contains '_Orders_'",
            fields: 'files(id, name)',
            orderBy: 'name desc'
        });

        if (!response.data.files || response.data.files.length === 0) {
            console.log('No CSV files found');
            return res.json({
                success: true,
                data: [],
                message: 'No sales data available'
            });
        }

        // Get current date and calculate date range
        const currentDate = new Date();
        const startDate = new Date(currentDate);
        startDate.setDate(currentDate.getDate() - 30); // Get last 30 days

        // Initialize sales data for date range
        const dailySales = {};
        let date = new Date(startDate);
        
        // Fill in all dates for the last 30 days
        while (date <= currentDate) {
            const dateKey = date.toISOString().split('T')[0];
            dailySales[dateKey] = 0;
            date.setDate(date.getDate() + 1);
        }

        console.log(`Found ${response.data.files.length} CSV files`);

        // Process each CSV file
        for (const file of response.data.files) {
            try {
                console.log(`Processing file: ${file.name}`);
                const fileData = await drive.files.get({
                    fileId: file.id,
                    alt: 'media'
                }, {
                    responseType: 'text'
                });

                const rows = fileData.data.split('\n');
                console.log(`Found ${rows.length} rows in ${file.name}`);
                
                // Skip header row
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i].trim();
                    if (!row) continue;
                    
                    const columns = row.split(',');
                    
                    // Ensure we have enough columns
                    if (columns.length < 10) {
                        console.log(`Skipping invalid row ${i}: insufficient columns`);
                        continue;
                    }
                    
                    // Check if order is completed and not cancelled
                    if (columns[7]?.trim() === '1' && columns[8]?.trim() === '0') {
                        try {
                            // Get date from array[1] (orders_logdate)
                            const orderDateStr = columns[1]?.trim();
                            if (!orderDateStr) {
                                console.log(`Skipping row ${i}: no date`);
                                continue;
                            }

                            // Parse the date string (assuming format: YYYY-MM-DD HH:mm:ss)
                            const [datePart] = orderDateStr.split(' ');
                            const orderDate = new Date(datePart);
                            
                            if (isNaN(orderDate.getTime())) {
                                console.log(`Invalid date in row ${i}: ${orderDateStr}`);
                                continue;
                            }

                            const dateKey = orderDate.toISOString().split('T')[0];

                            // Only add sales if it's within our date range
                            if (dailySales.hasOwnProperty(dateKey)) {
                                // Add sales amount from array[9]
                                const amount = parseFloat(columns[9]?.trim().replace(/[^\d.-]/g, '')) || 0;
                                dailySales[dateKey] += amount;
                                console.log(`Added PHP ${amount} to ${dateKey}`);
                            }
                        } catch (error) {
                            console.error(`Error processing row ${i}:`, error);
                            continue;
                        }
                    }
                }
            } catch (error) {
                console.error(`Error processing file ${file.name}:`, error);
                continue;
            }
        }

        // Convert to array and sort by date
        const sortedData = Object.entries(dailySales)
            .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
            .map(([date, amount]) => ({
                date,
                amount: Math.round(amount * 100) / 100
            }));

        console.log('Processed sales data:', sortedData);

        // Before sending response, update cache
        const responseData = {
            success: true,
            data: sortedData,
            dateRange: {
                start: startDate.toISOString().split('T')[0],
                end: currentDate.toISOString().split('T')[0]
            }
        };

        salesDataCache = {
            data: responseData,
            lastUpdated: Date.now()
        };

        res.json(responseData);
    } catch (error) {
        console.error('Error getting daily sales:', error);
        // If error occurs and we have cached data, return it
        if (salesDataCache.data) {
            console.log('Error occurred, returning cached data');
            return res.json(salesDataCache.data);
        }
        res.status(500).json({
            success: false,
            error: 'Failed to get daily sales data'
        });
    }
});

// Modify the checkForUpdates function to be more specific
async function checkForUpdates() {
    try {
        if (!drive) {
            const initialized = await initializeDrive();
            if (!initialized) return false;
        }

        // Get the latest CSV file
        const response = await drive.files.list({
            q: "mimeType='text/csv' and name contains '_Orders_'",
            fields: 'files(id, name, modifiedTime)',
            orderBy: 'modifiedTime desc',
            pageSize: 1
        });

        if (!response.data.files || response.data.files.length === 0) {
            return false;
        }

        const latestFile = response.data.files[0];
        
        // Check if this is new data
        if (latestFile.id !== lastProcessedData.lastFileId || 
            latestFile.modifiedTime !== lastProcessedData.lastModifiedTime) {
            
            console.log(`New data detected in file: ${latestFile.name}`);
            
            // Update tracking data
            lastProcessedData = {
                lastFileId: latestFile.id,
                lastModifiedTime: latestFile.modifiedTime
            };

            return true;
        }

        return false;
    } catch (error) {
        console.error('Error checking for updates:', error);
        return false;
    }
}

// Then move all WebSocket-related code here
wss.on('connection', (ws) => {
    console.log('Client connected');
    
    let isAlive = true;
    
    // Only check for updates on initial connection
    updateAndNotifyClient(ws);
    
    // Setup heartbeat
    const pingInterval = setInterval(() => {
        if (!isAlive) {
            clearInterval(pingInterval);
            return ws.terminate();
        }
        isAlive = false;
        ws.ping();
    }, 30000);

    ws.on('pong', () => {
        isAlive = true;
    });
    
    ws.on('close', () => {
        clearInterval(pingInterval);
        console.log('Client disconnected');
    });
});

// Add function to update and notify client
async function updateAndNotifyClient(ws) {
    const hasUpdates = await checkForUpdates();
    if (hasUpdates && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'REFRESH_REQUIRED',
            timestamp: new Date().toISOString()
        }));
    }
}

// Modify the webhook handler to be the primary trigger for updates
app.post('/api/webhook/drive', async (req, res) => {
    try {
        const { headers } = req;
        
        // Verify the notification is from Google
        if (headers['x-goog-resource-state'] === 'update' || 
            headers['x-goog-resource-state'] === 'create') {
            
            console.log('=== Processing CSV Files ===');
            const hasUpdates = await checkForUpdates();
            if (hasUpdates) {
                // Clear the cache to force fresh data fetch
                salesDataCache = {
                    data: null,
                    lastUpdated: null
                };
                
                // Notify all connected clients
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'REFRESH_REQUIRED',
                            timestamp: new Date().toISOString()
                        }));
                    }
                });
                console.log('================');
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Error processing webhook');
    }
});

// Add function to setup webhook
async function setupDriveWebhook() {
    try {
        if (!serviceAccountCredentials) {
            throw new Error('Service account credentials not initialized');
        }

        const auth = await google.auth.getClient({
            credentials: serviceAccountCredentials,
            scopes: ['https://www.googleapis.com/auth/drive']
        });

        const driveWebhook = google.drive({ version: 'v3', auth });

        // Your domain where the webhook will be hosted
        const domain = process.env.DOMAIN || 'your-domain.com';
        
        // Create a new watch request
        const response = await driveWebhook.files.watch({
            fileId: 'root', // Watch the entire Drive
            requestBody: {
                id: `drive-webhook-${Date.now()}`,
                type: 'web_hook',
                address: `https://${domain}/api/webhook/drive`,
                expiration: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
            }
        });

        console.log('Webhook setup successful:', response.data);
    } catch (error) {
        console.error('Error setting up webhook:', error);
    }
}

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        success: false, 
        error: 'Internal Server Error' 
    });
});

// Handle production errors
if (process.env.NODE_ENV === 'production') {
    app.use((err, req, res, next) => {
        res.status(err.status || 500);
        res.json({
            success: false,
            error: 'Server Error'
        });
    });
}

// Modify server start to ensure drive is initialized before setting up webhook
const startServer = (port) => {
    try {
        server.listen(port, async () => {
            console.log(`Server running on port ${port}`);
            
            // Initialize Drive first
            await initializeDrive();
            
            // Then setup webhook
            await setupDriveWebhook();
            
            console.log('Available endpoints:');
            console.log('  - GET /api/drive');
            console.log('  - GET /api/drive/folders');
            console.log('  - GET /api/drive/status');
            console.log('  - POST /api/webhook/drive');
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`Port ${port} is already in use.`);
                console.error('Please try these steps:');
                console.error('1. Close any other applications using port 3000');
                console.error('2. Run this command in PowerShell:');
                console.error('   netstat -ano | findstr :3000');
                console.error('   taskkill /PID XXXX /F  (replace XXXX with PID)');
                console.error('3. Then restart the server with: npm start');
                process.exit(1);
            } else {
                console.error('Server error:', err);
                process.exit(1);
            }
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

// Start the server
startServer(PORT); 