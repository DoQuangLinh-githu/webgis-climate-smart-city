// ==================== SIDEBAR MOBILE MANAGEMENT ====================
function initMobileSidebar() {
    const mobileToggleBtn = document.getElementById('mobileToggleBtn');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    if (!mobileToggleBtn || !sidebar || !sidebarOverlay) return;

    function toggleSidebar() {
        sidebar.classList.toggle('active');
        sidebarOverlay.classList.toggle('active');

        const icon = mobileToggleBtn.querySelector('i');
        if (icon) {
            if (sidebar.classList.contains('active')) {
                icon.classList.remove('fa-bars');
                icon.classList.add('fa-times');
            } else {
                icon.classList.remove('fa-times');
                icon.classList.add('fa-bars');
            }
        }
    }

    function closeSidebar() {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
        const icon = mobileToggleBtn.querySelector('i');
        if (icon) {
            icon.classList.remove('fa-times');
            icon.classList.add('fa-bars');
        }
    }

    mobileToggleBtn.addEventListener('click', toggleSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', closeSidebar);
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth > 992) closeSidebar();
    });
}

// ==================== REAL-TIME CLOCK ====================
function initRealTimeClock() {
    const clockTime = document.getElementById('clockTime');
    const clockDate = document.getElementById('clockDate');
    
    if (!clockTime && !clockDate) return;

    function updateClock() {
        const now = new Date();
        const options = {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        };
        const dateOptions = {
            timeZone: 'Asia/Ho_Chi_Minh',
            weekday: 'long',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        };

        if (clockTime) {
            clockTime.textContent = now.toLocaleTimeString('vi-VN', options);
        }
        if (clockDate) {
            clockDate.textContent = now.toLocaleDateString('vi-VN', dateOptions);
        }
    }

    updateClock();
    setInterval(updateClock, 1000);
}

// ==================== TOOLTIP INITIALIZATION ====================
function initTooltips() {
    if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
        document.querySelectorAll('[data-bs-toggle="tooltip"]')
            .forEach(el => new bootstrap.Tooltip(el));
    }
}

// ==================== AUTO-HIDE ALERTS ====================
function initAutoHideAlerts() {
    const alerts = document.querySelectorAll('.alert');
    alerts.forEach(alert => {
        setTimeout(() => {
            if (alert && alert.parentNode) {
                const bsAlert = new bootstrap.Alert(alert);
                bsAlert.close();
            }
        }, 5000);
    });
}

// ==================== NOTIFICATION FUNCTION ====================
function showNotification(type, message, duration = 5000) {
    const notification = document.createElement('div');
    notification.className = `alert alert-${type} alert-dismissible fade show position-fixed`;
    notification.style.cssText = `
        top: 100px; right: 20px; z-index: 9999; 
        min-width: 300px; border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    `;
    notification.innerHTML = `
        <div class="d-flex">
            <div class="alert-icon me-3">
                <i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-triangle'} fa-2x"></i>
            </div>
            <div class="flex-grow-1">
                <strong>${type === 'success' ? 'Thành công!' : 'Lỗi!'}</strong>
                <div class="small">${message}</div>
            </div>
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        </div>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        if (notification.parentNode) {
            notification.remove();
        }
    }, duration);
}

// ==================== NUMBER INPUT FORMATTING ====================
function initNumberInputs() {
    function normalizeNumberInput(input) {
        input.addEventListener('input', function () {
            let value = this.value;
            value = value.replace(/[^0-9.,-]/g, '');
            value = value.replace(/(?!^)-/g, '');

            const commaCount = (value.match(/,/g) || []).length;
            if (commaCount > 1) {
                value = value.replace(/,/g, (m, i) =>
                    i === value.indexOf(',') ? ',' : ''
                );
            }
            this.value = value;
        });

        input.addEventListener('blur', function () {
            let raw = this.value;
            if (!raw) return;

            let normalized = raw.replace(/\./g, '').replace(',', '.');
            const num = parseFloat(normalized);
            if (isNaN(num)) return;

            this.value = num.toLocaleString('vi-VN', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 10
            });
        });

        input.addEventListener('focus', function () {
            let raw = this.value;
            if (!raw) return;

            let normalized = raw.replace(/\./g, '').replace(',', '.');
            const num = parseFloat(normalized);
            if (!isNaN(num)) {
                this.value = num.toString().replace('.', ',');
            }
        });
    }

    document.querySelectorAll('input[type="number"]').forEach(input => {
        input.type = 'text';
        normalizeNumberInput(input);
    });
}

// ==================== SOURCE EDITOR ====================
function initSourceEditor() {
    document.addEventListener('click', function (e) {
        const wrapper = e.target.closest('.source-wrapper');
        if (!wrapper) return;

        const view = wrapper.querySelector('.source-view');
        const edit = wrapper.querySelector('.source-edit');
        const text = wrapper.querySelector('.source-text');
        const input = wrapper.querySelector('.source-input');

        if (e.target.closest('.btn-edit')) {
            if (input && text) {
                input.value = text.textContent.trim();
            }
            if (view) view.style.display = 'none';
            if (edit) edit.style.display = 'block';
        }

        if (e.target.closest('.btn-save')) {
            if (text && input) {
                text.textContent = input.value;
            }
            if (view) view.style.display = 'block';
            if (edit) edit.style.display = 'none';
        }

        if (e.target.closest('.btn-cancel')) {
            if (view) view.style.display = 'block';
            if (edit) edit.style.display = 'none';
        }
    });
}

// ==================== LOADING OVERLAY ====================
function showLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('show');
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.remove('show');
}

// ==================== INITIALIZE ALL ====================
document.addEventListener('DOMContentLoaded', () => {
    initMobileSidebar();
    initRealTimeClock();
    initTooltips();
    initAutoHideAlerts();
    initNumberInputs();
    initSourceEditor();
});

// ==================== CHART UTILITIES ====================
function downloadChart(chart, filename = 'chart.png') {
    if (!chart) return;
    const link = document.createElement('a');
    link.download = filename;
    link.href = chart.toBase64Image();
    link.click();
}

function toggleFullscreen(element) {
    if (!element) return;
    if (!document.fullscreenElement) {
        element.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}

function shareChart(url, title = 'Climate Smart City') {
    if (navigator.share) {
        navigator.share({
            title: title,
            url: url
        });
    } else {
        showNotification('info', 'Trình duyệt của bạn không hỗ trợ chia sẻ.');
    }
}

// ==================== FORM VALIDATION ====================
function validateForm(formId) {
    const form = document.getElementById(formId);
    if (!form) return false;
    
    if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return false;
    }
    return true;
}

// ==================== DELETE CONFIRMATION ====================
function confirmDelete(message = 'Bạn có chắc chắn muốn xóa mục này?') {
    return confirm(message);
}