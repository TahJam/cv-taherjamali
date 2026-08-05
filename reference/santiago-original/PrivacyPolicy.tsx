import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArticleLayout } from './articles/components'

const content = {
  es: {
    title: 'Politica de Privacidad',
    lastUpdated: 'Ultima actualizacion: 15 de marzo de 2026',
    intro: 'Esta politica describe como se recopilan y utilizan los datos cuando visitas santifer.io.',
    sections: [
      {
        heading: 'Que datos se recopilan',
        items: [
          'Mensajes del chatbot: cuando interactuas con el chatbot "Santi", los mensajes se procesan para generar respuestas. No se solicita ni almacena informacion personal identificable.',
          'Audio del modo voz: si activas el modo voz, el audio se procesa en tiempo real para la conversacion y no se almacena de forma permanente.',
          'Analiticas de uso: se recopilan datos anonimos de navegacion (paginas visitadas, duracion, dispositivo) para mejorar el sitio.',
        ],
      },
      {
        heading: 'Como se utilizan los datos',
        items: [
          'Los mensajes del chatbot se utilizan exclusivamente para generar respuestas contextuales sobre la experiencia profesional de Santiago.',
          'Las trazas de conversacion se almacenan de forma anonimizada para mejorar la calidad de las respuestas y detectar intentos de uso indebido.',
          'Los datos de analiticas se utilizan para entender patrones de uso y mejorar el rendimiento del sitio.',
        ],
      },
      {
        heading: 'Terceros',
        items: [
          'Anthropic (Claude): procesa los mensajes del chatbot para generar respuestas.',
          'OpenAI (Realtime API): procesa el audio del modo voz para la conversacion en tiempo real.',
          'Langfuse: almacena trazas anonimizadas de conversaciones para observabilidad y mejora de calidad.',
          'Vercel: aloja el sitio web y recopila analiticas anonimas de uso.',
        ],
      },
      {
        heading: 'Cookies y almacenamiento local',
        body: 'Este sitio no utiliza cookies de seguimiento ni de terceros. Solo se utiliza localStorage del navegador para preferencias de interfaz (tema visual). No se almacena informacion personal.',
      },
      {
        heading: 'No hay cuentas de usuario',
        body: 'Este sitio no requiere registro ni inicio de sesion. No se recopilan nombres, emails ni contrasenas a traves del sitio web.',
      },
      {
        heading: 'Contacto',
        body: 'Para cualquier consulta sobre privacidad, puedes escribir a:',
        email: 'hi@santifer.io',
      },
    ],
    backHome: 'Volver al inicio',
  },
  en: {
    title: 'Privacy Policy',
    lastUpdated: 'Last updated: March 15, 2026',
    intro: 'This policy describes how data is collected and used when you visit santifer.io.',
    sections: [
      {
        heading: 'What data is collected',
        items: [
          'Chatbot messages: when you interact with the "Santi" chatbot, messages are processed to generate responses. No personally identifiable information is requested or stored.',
          'Voice mode audio: if you activate voice mode, audio is processed in real time for conversation and is not permanently stored.',
          'Usage analytics: anonymous browsing data (pages visited, duration, device) is collected to improve the site.',
        ],
      },
      {
        heading: 'How data is used',
        items: [
          "Chatbot messages are used exclusively to generate contextual responses about Santiago's professional experience.",
          'Conversation traces are stored in anonymized form to improve response quality and detect misuse attempts.',
          'Analytics data is used to understand usage patterns and improve site performance.',
        ],
      },
      {
        heading: 'Third parties',
        items: [
          'Anthropic (Claude): processes chatbot messages to generate responses.',
          'OpenAI (Realtime API): processes voice mode audio for real-time conversation.',
          'Langfuse: stores anonymized conversation traces for observability and quality improvement.',
          'Vercel: hosts the website and collects anonymous usage analytics.',
        ],
      },
      {
        heading: 'Cookies and local storage',
        body: 'This site does not use tracking cookies or third-party cookies. Only browser localStorage is used for interface preferences (visual theme). No personal information is stored.',
      },
      {
        heading: 'No user accounts',
        body: 'This site does not require registration or login. No names, emails, or passwords are collected through the website.',
      },
      {
        heading: 'Contact',
        body: 'For any privacy-related inquiries, you can write to:',
        email: 'hi@santifer.io',
      },
    ],
    backHome: 'Back to home',
  },
} as const

interface PrivacySection {
  heading: string
  items?: readonly string[]
  body?: string
  email?: string
}

export default function PrivacyPolicy({ lang = 'es' }: { lang?: 'es' | 'en' }) {
  const t = content[lang]

  useEffect(() => {
    document.title = `${t.title} | santifer.io`

    // noindex
    let robots = document.querySelector('meta[name="robots"]') as HTMLMetaElement
    if (!robots) {
      robots = document.createElement('meta')
      robots.name = 'robots'
      document.head.appendChild(robots)
    }
    robots.content = 'noindex, nofollow'

    // Fix canonical (SPA fallback serves homepage canonical — override it)
    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement
    if (canonical) canonical.href = `https://santifer.io/${lang === 'es' ? 'privacidad' : 'privacy'}`

    // Fix meta description
    let desc = document.querySelector('meta[name="description"]') as HTMLMetaElement
    if (desc) desc.content = lang === 'es'
      ? 'Politica de privacidad de santifer.io. Como se recopilan y utilizan los datos del chatbot y la web.'
      : 'Privacy policy for santifer.io. How chatbot and website data is collected and used.'

    return () => {
      robots.content = 'index, follow'
    }
  }, [lang, t.title])

  return (
    <ArticleLayout lang={lang}>
      <header className="mb-10">
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-2">
          {t.title}
        </h1>
        <p className="text-sm text-muted-foreground">{t.lastUpdated}</p>
      </header>

      <article className="prose-custom">
        <p className="text-base md:text-lg text-muted-foreground leading-relaxed mb-8">
          {t.intro}
        </p>

        {(t.sections as readonly PrivacySection[]).map((section, i) => (
          <section key={i} className="mb-8">
            <h2 className="font-display text-xl font-semibold text-foreground mb-3">
              {section.heading}
            </h2>

            {section.items && (
              <ul className="space-y-2 mb-4">
                {section.items.map((item, j) => (
                  <li key={j} className="flex gap-3 text-base text-muted-foreground">
                    <span className="text-primary font-bold shrink-0 mt-0.5">{'●'}</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}

            {section.body && (
              <p className="text-base text-muted-foreground leading-relaxed">
                {section.body}
              </p>
            )}

            {section.email && (
              <p className="mt-2">
                <a
                  href={`mailto:${section.email}`}
                  className="text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  {section.email}
                </a>
              </p>
            )}
          </section>
        ))}

        <div className="mt-12 pt-8 border-t border-border">
          <Link
            to={lang === 'es' ? '/' : '/en'}
            className="inline-flex items-center gap-2 text-primary hover:underline font-medium"
          >
            {'← '}{t.backHome}
          </Link>
        </div>
      </article>
    </ArticleLayout>
  )
}
