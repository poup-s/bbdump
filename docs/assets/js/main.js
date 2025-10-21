// BBDUMP - Landing Page JavaScript

// Smooth scroll with offset for fixed nav
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            const offset = 70;
            const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - offset;
            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
        }
    });
});

// Navbar scroll effect
let lastScroll = 0;
const nav = document.querySelector('.nav');

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;

    // Add shadow on scroll
    if (currentScroll > 100) {
        nav.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
    } else {
        nav.style.boxShadow = 'none';
    }

    lastScroll = currentScroll;
});

// Mobile menu toggle
const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
const navLinks = document.querySelector('.nav-links');

if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        mobileMenuBtn.classList.toggle('active');
    });
}

// Intersection Observer for fade-in animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Observe all feature cards and demo elements
document.querySelectorAll('.feature-card, .step, .tech-item').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
});

// Add stagger effect to feature cards
document.querySelectorAll('.feature-card').forEach((card, idx) => {
    card.style.transitionDelay = (idx * 0.1) + 's';
});

// Count up animation for stats
function animateCount(element, target, duration) {
    duration = duration || 2000;
    const start = 0;
    const increment = target / (duration / 16);
    let current = start;

    const timer = setInterval(() => {
        current += increment;
        if (current >= target) {
            element.textContent = target;
            clearInterval(timer);
        } else {
            element.textContent = Math.floor(current);
        }
    }, 16);
}

// Trigger count animation when stats come into view
const statsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const statValues = entry.target.querySelectorAll('.stat-value');
            statValues.forEach(stat => {
                const text = stat.textContent;
                if (!isNaN(text)) {
                    animateCount(stat, parseInt(text));
                }
            });
            statsObserver.unobserve(entry.target);
        }
    });
}, { threshold: 0.5 });

const heroStats = document.querySelector('.hero-stats');
if (heroStats) {
    statsObserver.observe(heroStats);
}

// Dynamic gradient animation
const gradientText = document.querySelector('.gradient-text');
if (gradientText) {
    let hue = 250;
    setInterval(() => {
        hue = (hue + 1) % 360;
        const nextHue = (hue + 30) % 360;
        const gradient = 'linear-gradient(135deg, hsl(' + hue + ', 70%, 60%) 0%, hsl(' + nextHue + ', 70%, 60%) 100%)';
        gradientText.style.background = gradient;
        gradientText.style.webkitBackgroundClip = 'text';
        gradientText.style.backgroundClip = 'text';
    }, 50);
}

// Parallax effect for hero
window.addEventListener('scroll', () => {
    const scrolled = window.pageYOffset;
    const heroContent = document.querySelector('.hero-content');
    if (heroContent && scrolled < window.innerHeight) {
        heroContent.style.transform = 'translateY(' + (scrolled * 0.5) + 'px)';
        heroContent.style.opacity = 1 - (scrolled / window.innerHeight);
    }
});

// Copy code to clipboard
document.querySelectorAll('.code-block').forEach(block => {
    block.style.cursor = 'pointer';
    block.title = 'Click to copy';

    block.addEventListener('click', () => {
        const text = block.textContent;
        navigator.clipboard.writeText(text).then(() => {
            const originalText = block.textContent;
            block.textContent = '✓ Copied!';
            setTimeout(() => {
                block.textContent = originalText;
            }, 2000);
        });
    });
});

// Add rainbow animation
const style = document.createElement('style');
style.textContent = '@keyframes rainbow { 0% { filter: hue-rotate(0deg); } 100% { filter: hue-rotate(360deg); } }';
document.head.appendChild(style);

// Console message
console.log('%c🎉 bbdump ', 'background: #000; color: #fff; font-size: 24px; font-weight: bold; padding: 10px;');
console.log('%cThanks for checking out bbdump!', 'font-size: 14px; color: #667eea;');
console.log('%c⭐ Star us on GitHub', 'font-size: 12px; color: #666;');
