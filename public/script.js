// Add these functions at the top of your script
function showPopup(message) {
    const popup = document.getElementById('error-popup');
    const popupMessage = document.getElementById('popup-message');
    popupMessage.textContent = message;
    popup.classList.add('show');
}

function closePopup() {
    const popup = document.getElementById('error-popup');
    popup.classList.remove('show');
    
    // Clear input fields
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    
    // Optional: Set focus to username field
    document.getElementById('username').focus();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorMessage = document.getElementById('error-message');
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Store username in localStorage
            localStorage.setItem('username', data.username);
            // Redirect to dashboard
            window.location.href = '/dashboard.html';
        } else {
            errorMessage.textContent = data.error || 'Login failed';
            errorMessage.style.display = 'block';
        }
    } catch (error) {
        console.error('Login error:', error);
        errorMessage.textContent = 'Login failed. Please try again.';
        errorMessage.style.display = 'block';
    }
});

// Clear error message when user starts typing
document.getElementById('username').addEventListener('input', () => {
    document.getElementById('error-message').style.display = 'none';
});

document.getElementById('password').addEventListener('input', () => {
    document.getElementById('error-message').style.display = 'none';
});

// Close popup when clicking outside
document.addEventListener('click', (e) => {
    const popup = document.getElementById('error-popup');
    if (e.target === popup) {
        closePopup();
    }
});

// Close popup with Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closePopup();
    }
}); 