/**
 * Mini systeme de toasts (notifications breves).
 */

const DEFAULT_DURATION = 3000;

export function showToast(message, options = {}) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast";
  if (options.type === "error") toast.classList.add("toast-error");
  if (options.type === "success") toast.classList.add("toast-success");
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = "opacity 0.25s ease, transform 0.25s ease";
    toast.style.opacity = "0";
    toast.style.transform = "scale(0.9)";
    setTimeout(() => toast.remove(), 280);
  }, options.duration ?? DEFAULT_DURATION);
}
