// apps/backend/app/layout.tsx
export const metadata = {
  title: "AI Agent Backend",
  description: "KB API + minimal root layout for Next.js app router",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, Arial, sans-serif", margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
