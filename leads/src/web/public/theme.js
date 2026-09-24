// Aplica o tema escolhido antes de desenhar a página (evita piscar branco no tema escuro).
(() => {
  try {
    const theme = localStorage.getItem('cl_theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch {
    // Armazenamento bloqueado: fica o tema do sistema.
  }
})();
