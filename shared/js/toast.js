/**
 * Mini systeme de toasts (notifications breves).
 */

const DEFAULT_DURATION = 3000;

export function showToast(message, options = {}) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast";
  if (options.type === "error") toast.classList.add("error");
  if (options.type === "success") toast.classList.add("success");
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = "opacity 0.2s, transform 0.2s";
    toast.style.opacity = "0";
    toast.style.transform = "translateX(20px)";
    setTimeout(() => toast.remove(), 250);
  }, options.duration ?? DEFAULT_DURATION);
}
