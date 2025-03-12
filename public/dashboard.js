// Set current date
document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
});

// Get and display username from localStorage
const username = localStorage.getItem('username');
if (username) {
    document.getElementById('username-display').textContent = username;
}

// Logout functionality
document.getElementById('logout-btn').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem('username');
    window.location.href = '/';
});

// Google Drive Integration
const connectionText = document.getElementById('connection-text');
const statusIcon = document.querySelector('.status-icon');

function updateConnectionStatus(status, message) {
    connectionText.textContent = message;
    statusIcon.className = 'status-icon ' + status;
}

async function checkConnection() {
    updateConnectionStatus('checking', 'Checking connection...');
    
    try {
        const response = await fetch('/api/drive/status');
        const data = await response.json();
        
        if (data.connected) {
            updateConnectionStatus('connected', 'Connected to Google Drive');
            updateTransactionCount();
        } else {
            updateConnectionStatus('disconnected', 'Disconnected');
            await autoConnect();
        }
    } catch (error) {
        console.error('Connection check failed:', error);
        updateConnectionStatus('disconnected', 'Connection failed');
    }
}

async function autoConnect() {
    try {
        updateConnectionStatus('checking', 'Connecting to Google Drive...');
        const response = await fetch('/api/drive/connect');
        const data = await response.json();
        
        if (data.success) {
            updateConnectionStatus('connected', 'Connected to Google Drive');
        } else {
            updateConnectionStatus('disconnected', 'Connection failed');
        }
    } catch (error) {
        console.error('Auto-connect failed:', error);
        updateConnectionStatus('disconnected', 'Connection failed');
    }
}

// Check connection status when page loads
checkConnection();

// Update the updateTransactionCount function
async function updateTransactionCount() {
    try {
        const response = await fetch('/api/transactions/count');
        const data = await response.json();
        
        if (data.success) {
            // Update total sales
            const salesElement = document.getElementById('sales-amount');
            const salesTrendElement = salesElement?.nextElementSibling;
            if (salesElement) {
                salesElement.textContent = `PHP ${data.sales.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
                if (salesTrendElement) {
                    salesTrendElement.textContent = '↑ Total Sales';
                    salesTrendElement.className = 'trend positive';
                }
            }

            // Update guest count
            const guestElement = document.getElementById('guest-count');
            const guestTrendElement = document.getElementById('guest-trend');
            if (guestElement) {
                guestElement.textContent = data.guests.toLocaleString();
                if (guestTrendElement) {
                    guestTrendElement.textContent = '↑ Total Guests';
                    guestTrendElement.className = 'trend positive';
                }
            }

            // Update transaction count
            const countElement = document.getElementById('transaction-count');
            const countTrendElement = document.getElementById('transaction-trend');
            if (countElement) {
                countElement.textContent = data.count.toLocaleString();
                if (countTrendElement) {
                    countTrendElement.textContent = '↑ Total Complete';
                    countTrendElement.className = 'trend positive';
                }
            }

            // Clear any error states
            [salesElement, guestElement, countElement].forEach(el => {
                if (el) el.parentElement.classList.remove('error-state');
            });
        } else {
            throw new Error(data.error || 'Failed to load data');
        }
    } catch (error) {
        console.error('Error fetching transaction data:', error);
        
        // Update error states for all cards
        const cardIds = ['sales-amount', 'guest-count', 'transaction-count'];
        cardIds.forEach(id => {
            const element = document.getElementById(id);
            const trendElement = element?.nextElementSibling;
            if (element) {
                element.textContent = 'Error';
                element.parentElement.classList.add('error-state');
                if (trendElement) {
                    trendElement.textContent = '⚠️ Failed to load';
                    trendElement.className = 'trend neutral';
                }
            }
        });
    }
}

// Add automatic refresh every 30 seconds
setInterval(updateTransactionCount, 30000);

// Declare chart variable at the top level
let salesChart = null;

async function updateSalesChart() {
    try {
        console.log('Fetching sales data...');
        const response = await fetch('/api/sales/daily');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('Received sales data:', data);
        
        if (data.success && data.data.length > 0) {
            const canvas = document.getElementById('salesChart');
            if (!canvas) {
                console.error('Could not find salesChart canvas element');
                return;
            }

            // Update chart title with date range
            const startDate = new Date(data.dateRange.start);
            const endDate = new Date(data.dateRange.end);
            const titleElement = canvas.parentElement.querySelector('h3');
            if (titleElement) {
                titleElement.textContent = `Sales Trend (${startDate.toLocaleDateString('en-US', { 
                    month: 'short', 
                    day: 'numeric' 
                })} - ${endDate.toLocaleDateString('en-US', { 
                    month: 'short', 
                    day: 'numeric' 
                })})`;
            }

            const chartData = {
                labels: data.data.map(item => {
                    const date = new Date(item.date);
                    return date.toLocaleDateString('en-US', { 
                        month: 'short', 
                        day: 'numeric'
                    });
                }),
                datasets: [{
                    label: 'Daily Sales',
                    data: data.data.map(item => item.amount),
                    backgroundColor: 'rgba(64, 192, 255, 0.2)',
                    borderColor: 'rgba(64, 192, 255, 1)',
                    borderWidth: 1,
                    borderRadius: 5
                }]
            };

            // Destroy existing chart if it exists
            if (salesChart instanceof Chart) {
                salesChart.destroy();
            }

            // Create new chart
            salesChart = new Chart(canvas, {
                type: 'bar',
                data: chartData,
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 1000
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            },
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                callback: function(value) {
                                    if (value >= 1000) {
                                        return 'PHP ' + (value / 1000).toFixed(1) + 'K';
                                    }
                                    return 'PHP ' + value.toLocaleString();
                                },
                                maxTicksLimit: window.innerWidth < 768 ? 4 : 5,
                                font: {
                                    size: window.innerWidth < 768 ? 10 : 11
                                }
                            }
                        },
                        x: {
                            grid: {
                                display: false
                            },
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                maxRotation: window.innerWidth < 768 ? 45 : 0,
                                minRotation: window.innerWidth < 768 ? 45 : 0,
                                autoSkip: true,
                                maxTicksLimit: window.innerWidth < 768 ? 7 : 12,
                                font: {
                                    size: window.innerWidth < 768 ? 10 : 11
                                }
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            enabled: true,
                            callbacks: {
                                label: function(context) {
                                    const value = context.parsed.y;
                                    return 'PHP ' + value.toLocaleString();
                                }
                            },
                            backgroundColor: 'rgba(10, 25, 47, 0.95)',
                            padding: window.innerWidth < 768 ? 8 : 12,
                            titleFont: {
                                size: window.innerWidth < 768 ? 12 : 13
                            },
                            bodyFont: {
                                size: window.innerWidth < 768 ? 11 : 12
                            }
                        }
                    },
                    layout: {
                        padding: {
                            top: window.innerWidth < 768 ? 10 : 20,
                            right: window.innerWidth < 768 ? 5 : 15,
                            bottom: window.innerWidth < 768 ? 10 : 20,
                            left: window.innerWidth < 768 ? 5 : 15
                        }
                    }
                }
            });

            console.log('Chart created successfully');
        } else {
            throw new Error(data.error || 'No sales data available');
        }
    } catch (error) {
        console.error('Error updating sales chart:', error);
        const canvas = document.getElementById('salesChart');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#ff4757';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Failed to load sales data', canvas.width/2, canvas.height/2);
        }
    }
}

// Initialize chart when page loads
document.addEventListener('DOMContentLoaded', () => {
    updateSalesChart();
    
    // Update chart every 30 seconds
    setInterval(updateSalesChart, 30000);

    // Mobile menu toggle
    const menuToggle = document.getElementById('menu-toggle');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const mainContent = document.querySelector('.main-content');

    // Toggle sidebar
    menuToggle?.addEventListener('click', () => {
        sidebar.classList.toggle('active');
        overlay.classList.toggle('active');
        document.body.style.overflow = sidebar.classList.contains('active') ? 'hidden' : 'auto';
    });

    // Close sidebar when clicking overlay
    overlay?.addEventListener('click', () => {
        sidebar.classList.remove('active');
        overlay.classList.remove('active');
        document.body.style.overflow = 'auto';
    });

    // Close sidebar when clicking main content
    mainContent?.addEventListener('click', () => {
        if (sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
            overlay.classList.remove('active');
            document.body.style.overflow = 'auto';
        }
    });

    // Close sidebar on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
            overlay.classList.remove('active');
            document.body.style.overflow = 'auto';
        }
    });

    // Update chart responsiveness
    const updateChartSize = () => {
        if (salesChart instanceof Chart) {
            salesChart.resize();
        }
    };

    // Listen for window resize
    window.addEventListener('resize', updateChartSize);
}); 