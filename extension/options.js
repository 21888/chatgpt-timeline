// Options page: make settings fit in one screen by grouping into panels.
document.addEventListener('DOMContentLoaded', () => {
    const navItems = Array.from(document.querySelectorAll('.settings-nav-item'));
    const panels = Array.from(document.querySelectorAll('.settings-panel'));

    if (!navItems.length || !panels.length) return;

    const activate = (targetId) => {
        navItems.forEach((btn) => {
            const isActive = btn.getAttribute('data-target') === targetId;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        panels.forEach((panel) => {
            const isActive = panel.id === targetId;
            panel.classList.toggle('is-active', isActive);
            panel.hidden = !isActive;
        });

        const activePanel = document.getElementById(targetId);
        if (activePanel) activePanel.scrollTop = 0;
    };

    navItems.forEach((btn) => {
        btn.setAttribute('role', 'tab');
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            if (targetId) activate(targetId);
        });
    });

    const initial = navItems.find((b) => b.classList.contains('is-active')) || navItems[0];
    const initialTarget = initial.getAttribute('data-target');
    if (initialTarget) activate(initialTarget);
});

