// public/js/cndl/main.js
document.addEventListener('DOMContentLoaded', () => {
    // Tooltip initialization
    document.querySelectorAll('[data-bs-toggle="tooltip"]')
        .forEach(el => new bootstrap.Tooltip(el));

    // Hiển thị/ẩn indicator khi checkbox thay đổi
    document.querySelectorAll('.indicator-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', function () {
            const indicatorId = this.id.replace('check_', '');
            const section = document.getElementById('section_' + indicatorId);
            if (section) {
                section.style.display = this.checked ? 'block' : 'none';
                if (!this.checked) {
                    section.querySelectorAll('input, select').forEach(input => input.value = '');
                }
            }
        });
        checkbox.dispatchEvent(new Event('change'));
    });

    // Chuẩn hóa số nhập
    function normalizeNumberInput(input) {
        input.addEventListener('input', function () {
            let value = this.value.replace(/[^0-9.,-]/g, '');
            this.value = value;
        });
        input.addEventListener('blur', function () {
            let raw = this.value;
            if (!raw) return;
            let normalized = raw.replace(/\./g, '').replace(',', '.');
            let num = parseFloat(normalized);
            if (!isNaN(num)) this.value = num.toLocaleString('vi-VN');
        });
    }
    document.querySelectorAll('.indicator-section input[type="text"]').forEach(normalizeNumberInput);

    // ==================== SOURCE EDIT FUNCTIONALITY ====================
    // Sử dụng event delegation để bắt sự kiện cho tất cả các nút (kể cả khi mới tạo)
    document.body.addEventListener('click', function(e) {
        // Xử lý nút "Sửa nguồn"
        const editBtn = e.target.closest('.btn-edit-source');
        if (editBtn) {
            const wrapper = editBtn.closest('.source-wrapper');
            if (wrapper) {
                const view = wrapper.querySelector('.source-view');
                const edit = wrapper.querySelector('.source-edit');
                const text = wrapper.querySelector('.source-text');
                const input = wrapper.querySelector('.source-input');
                
                if (view && edit && text && input) {
                    input.value = text.textContent.trim();
                    view.style.display = 'none';
                    edit.style.display = 'block';
                }
            }
            e.preventDefault();
            return;
        }
        
        // Xử lý nút "Lưu"
        const saveBtn = e.target.closest('.btn-save-source');
        if (saveBtn) {
            const wrapper = saveBtn.closest('.source-wrapper');
            if (wrapper) {
                const view = wrapper.querySelector('.source-view');
                const edit = wrapper.querySelector('.source-edit');
                const text = wrapper.querySelector('.source-text');
                const input = wrapper.querySelector('.source-input');
                
                if (view && edit && text && input && input.value.trim()) {
                    text.textContent = input.value.trim();
                    view.style.display = 'block';
                    edit.style.display = 'none';
                    
                    // Lưu vào localStorage hoặc gửi lên server
                    const param = wrapper.dataset.key;
                    const indicatorCode = wrapper.closest('.indicator-section')?.id.replace('section_', '');
                    if (indicatorCode && param) {
                        saveSourceToServer(indicatorCode, param, input.value.trim());
                    }
                }
            }
            e.preventDefault();
            return;
        }
        
        // Xử lý nút "Hủy"
        const cancelBtn = e.target.closest('.btn-cancel-source');
        if (cancelBtn) {
            const wrapper = cancelBtn.closest('.source-wrapper');
            if (wrapper) {
                const view = wrapper.querySelector('.source-view');
                const edit = wrapper.querySelector('.source-edit');
                
                if (view && edit) {
                    view.style.display = 'block';
                    edit.style.display = 'none';
                }
            }
            e.preventDefault();
            return;
        }
    });

    // Hàm lưu nguồn dữ liệu lên server
    async function saveSourceToServer(indicatorCode, param, sourceText) {
        try {
            const response = await fetch('/api/update-indicator-source', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{
                    indicator: indicatorCode,
                    param: param,
                    source_text: sourceText,
                    year: new Date().getFullYear(),
                    city: 'TP. Hồ Chí Minh'
                }])
            });
            if (response.ok) {
                console.log('✅ Đã lưu nguồn dữ liệu:', indicatorCode, param);
            }
        } catch (err) {
            console.error('Lỗi lưu nguồn:', err);
        }
    }

    // ==================== PREVIEW FUNCTIONALITY ====================
    async function calculatePreview(indicatorCode) {
        const button = document.querySelector(`button[data-indicator="${indicatorCode}"]`);
        const section = document.getElementById('section_' + indicatorCode);
        if (!section) {
            alert('Không tìm thấy chỉ số');
            return;
        }
        
        const inputs = section.querySelectorAll(`[name^="${indicatorCode}[params]"]`);
        
        // Kiểm tra required
        const isRequired = section.dataset.required === "true";
        const hasValue = [...inputs].some(i => i.value.trim());
        
        if (isRequired && !hasValue) {
            alert("Chỉ số này bắt buộc nhập dữ liệu!");
            return;
        }

        const params = {};
        inputs.forEach(input => {
            const paramName = input.name.match(/\[params\]\[(.+?)\]/)?.[1];
            if (paramName && input.value.trim()) {
                let val = input.value.trim().replace(/\./g, '').replace(',', '.');
                params[paramName] = parseFloat(val);
            }
        });

        try {
            const response = await fetch('/cndl/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    indicatorCode, 
                    params, 
                    year: new Date().getFullYear(), 
                    city: 'TP. Hồ Chí Minh' 
                })
            });
            const result = await response.json();

            document.getElementById('previewValue').textContent = result.value ?? 'N/A';
            document.getElementById('previewLevel').textContent = result.level || 'N/A';
            document.getElementById('previewScore').textContent = result.score ?? 'N/A';
            document.getElementById('previewDescription').textContent = result.description || 'Không có mô tả';
            new bootstrap.Modal(document.getElementById('previewModal')).show();
        } catch (err) {
            console.error('Preview error:', err);
            alert('Lỗi kết nối đến máy chủ');
        }
    }

    // Preview buttons
    document.querySelectorAll('.preview-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            calculatePreview(btn.dataset.indicator);
        });
    });
});

// Reset functions
window.resetIndicator = function(indicatorCode) {
    const section = document.getElementById('section_' + indicatorCode);
    if (section) {
        section.querySelectorAll('input[type="text"]').forEach(input => input.value = '');
        const chart = document.getElementById('chart_' + indicatorCode);
        if (chart) chart.style.display = 'none';
    }
};

window.resetSelectIndicator = function(indicatorCode) {
    const section = document.getElementById('section_' + indicatorCode);
    if (section) {
        const select = section.querySelector('select');
        if (select) select.value = '';
        const chart = document.getElementById('chart_' + indicatorCode);
        if (chart) chart.style.display = 'none';
    }
};

// Preview modal functions
window.applyToForm = function() {
    const modal = document.getElementById('previewModal');
    if (modal) {
        bootstrap.Modal.getInstance(modal).hide();
    }
};