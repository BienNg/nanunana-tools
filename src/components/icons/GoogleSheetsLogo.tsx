/** Google Sheets product mark (approximation of the official Workspace icon). */
export function GoogleSheetsLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path fill="#0F9D58" d="M11 8h15v9h11v21H11V8z" />
      <path fill="#87CEAC" d="M26 8h11L26 17z" />
      <path fill="#fff" d="M12 23h24v2H12zm0 6h24v2H12zm0 6h15v2H12z" />
    </svg>
  );
}
