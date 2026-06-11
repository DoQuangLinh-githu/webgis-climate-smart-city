// public/js/ai-chatbot.js
document.addEventListener('DOMContentLoaded', function() {
    // AI greeting theo giờ
    const hour = new Date().getHours();
    const greetingEl = document.getElementById('greetingText');
    const aiMessageEl = document.getElementById('aiMessage');
    const originalMessage = aiMessageEl?.innerHTML;
    
    if (greetingEl) {
        if (hour < 12) greetingEl.innerText = 'Chào buổi sáng! ☀️';
        else if (hour < 18) greetingEl.innerText = 'Chào buổi chiều! 🌤️';
        else greetingEl.innerText = 'Chào buổi tối! 🌙';
    }
    
    // Click avatar để đổi tin nhắn
    const aiAvatar = document.getElementById('aiAvatar');
    if (aiAvatar) {
        aiAvatar.addEventListener('click', function() {
            const messages = [
                "✨ Bạn cần hỗ trợ gì về Climate Smart City?",
                "🌍 Hơn 10.000 người dùng đã tin tưởng chúng tôi!",
                "📊 Xem ngay chỉ số chất lượng không khí hôm nay!",
                "💚 Hãy chung tay xây dựng thành phố xanh!",
                "🎯 Đăng nhập để trải nghiệm bản đồ thông minh!"
            ];
            const randomMsg = messages[Math.floor(Math.random() * messages.length)];
            if (aiMessageEl) {
                aiMessageEl.style.opacity = '0';
                setTimeout(() => {
                    aiMessageEl.innerHTML = randomMsg;
                    aiMessageEl.style.opacity = '1';
                }, 200);
                setTimeout(() => {
                    aiMessageEl.style.opacity = '0';
                    setTimeout(() => {
                        aiMessageEl.innerHTML = originalMessage;
                        aiMessageEl.style.opacity = '1';
                    }, 200);
                }, 3500);
            }
        });
    }
});