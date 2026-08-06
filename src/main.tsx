import { StrictMode, lazy, Suspense, useState, useEffect, useRef, type ReactNode } from 'react'
import { hydrateRoot, createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, useLocation, Link } from 'react-router-dom'
import { Analytics } from '@vercel/analytics/react'
import './index.css'
import App from './App.tsx'
import GlobalNav from './GlobalNav.tsx'
import FloatingChat from './FloatingChat.tsx'

const OpsDashboard = lazy(() => import('./ops/OpsDashboard'))

/** Reset scroll + fade-in on route change (no animation on initial load to match prerender) */
function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { pathname } = location
  const initialPathname = useRef(pathname)
  const [hasNavigated, setHasNavigated] = useState(false)

  useEffect(() => {
    if (pathname !== initialPathname.current) {
      setHasNavigated(true)
    }

    if (location.hash) {
      // Hash scroll: multi-pass to handle async rendering + highlight on final pass
      const hash = location.hash
      const scroll = () => {
        const el = document.querySelector(hash)
        el?.scrollIntoView({ behavior: 'instant' })
        return el
      }
      const t1 = setTimeout(scroll, 50)
      const t2 = setTimeout(scroll, 300)
      const t3 = setTimeout(() => {
        const el = scroll()
        if (el instanceof HTMLElement) {
          el.classList.add('hash-highlight')
          el.addEventListener('animationend', () => el.classList.remove('hash-highlight'), { once: true })
        }
      }, 800)
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    }
  }, [pathname, location.hash, location.key])

  return (
    <div key={pathname} style={hasNavigated ? { animation: 'page-fade-in 0.25s ease-out' } : undefined}>
      {children}
    </div>
  )
}

function ConditionalNav() {
  const { pathname } = useLocation()
  if (pathname.startsWith('/ops')) return null
  return <GlobalNav />
}

function ConditionalChat() {
  const { pathname } = useLocation()
  if (pathname.startsWith('/ops')) return null
  return <FloatingChat />
}

function NotFound() {
  useEffect(() => {
    let robots = document.querySelector('meta[name="robots"]') as HTMLMetaElement
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots) }
    robots.content = 'noindex, nofollow'
    document.title = '404 — Page not found'
    return () => { robots.content = 'index, follow' }
  }, [])

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center text-center px-6">
      <p className="text-8xl font-display font-bold text-primary mb-4">404</p>
      <h1 className="text-2xl font-display font-semibold text-foreground mb-2">Page not found</h1>
      <p className="text-muted-foreground mb-8 max-w-md">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <Link
        to="/"
        className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
      >
        ← Back to home
      </Link>
    </div>
  )
}

const root = document.getElementById('root')!
const app = (
  <StrictMode>
    <BrowserRouter>
      <ConditionalNav />
      <PageTransition>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<App />} />
            <Route path="/ops" element={<OpsDashboard />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </PageTransition>
      <ConditionalChat />
      <Analytics />
    </BrowserRouter>
  </StrictMode>
)

// Hydrate if pre-rendered content exists, createRoot for dev mode
if (root.hasChildNodes()) {
  hydrateRoot(root, app)
} else {
  createRoot(root).render(app)
}
