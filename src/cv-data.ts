/**
 * Structured CV content — single source of truth for the homepage.
 *
 * Employer/internal-system detail is intentionally generalized (no internal
 * tool names, ticket numbers, or platform-vendor names) — see project memory
 * "goal-fork-cv-santiago" for why.
 */

export const PROFILE = {
  name: 'Taher Jamali',
  title: 'Software Engineer — Machine Learning & Platform Security',
  tagline: 'I turn manual pentesting into systems that watch themselves.',
  location: 'Austin, TX',
  email: 'taher2152@gmail.com',
  github: 'https://github.com/TahJam',
  githubHandle: 'github.com/TahJam',
  linkedin: 'https://linkedin.com/in/taher-jamali',
  linkedinHandle: 'linkedin.com/in/taher-jamali',
  summary:
    "I build AI agents and security automation that hold up in production, not just in demos. My flagship project is an autonomous multi-agent system that pentests cloud applications end-to-end — but the thread through most of my work is the same: find the manual, error-prone process and replace it with a system that runs itself, catches its own failures loudly, and scales past the point a human could keep up.",
} as const

export interface SkillGroup {
  category: string
  skills: string[]
}

export const SKILLS: SkillGroup[] = [
  {
    category: 'AI / ML Engineering',
    skills: [
      'Multi-agent AI systems', 'LLM integration (Claude, Gemini, OpenAI)',
      'RAG architecture', 'Agent evaluation & benchmarking',
      'Prompt engineering', 'LangChain / LangGraph', 'Model Context Protocol (MCP)',
    ],
  },
  {
    category: 'Security Engineering',
    skills: [
      'Penetration testing (blackbox & whitebox)', 'Vulnerability scanning',
      'Auth / authz testing', 'mTLS & certificate management',
      'Security automation & CI/CD gating', 'RBAC design',
    ],
  },
  {
    category: 'Distributed Systems & Reliability',
    skills: [
      'Durable queues', 'Circuit breakers', 'Idempotent design',
      'Outbox pattern', 'Fleet-scale scheduling', 'Kubernetes',
    ],
  },
  {
    category: 'Full-Stack & Platform',
    skills: [
      'React', 'REST APIs (Express, FastAPI)', 'Real-time streaming (SSE)',
      'SQLite', 'AWS', 'Docker', 'Dashboard / operator UX design',
    ],
  },
]

export interface ExperienceEntry {
  company: string
  role: string
  period: string
  location?: string
  bullets: string[]
}

export const EXPERIENCE: ExperienceEntry[] = [
  {
    company: 'Enterprise Cloud Platform Team, Fortune 500 Technology Company',
    role: 'Software Engineer — Platform Security, Infrastructure & AI/ML',
    period: '2024 – Present',
    bullets: [
      'Designed and built an autonomous multi-agent AI penetration-testing system (Python, Claude, Gemini) that discovers and tests production applications end-to-end — blackbox and whitebox — reaching 95% single-pass accuracy on a 24-case benchmark, and used the benchmark to decide which model to route to security-critical vs. high-volume scanning.',
      'Root-caused a production bug that caused up to 68x redundant scheduled work per application; replaced the compensating retry logic with a durable, structurally-enforced queue that eliminated the failure class instead of papering over it.',
      'Designed and shipped a full-stack operator dashboard (React, Express, SQLite) that replaced CLI-only tooling for a fleet-wide security scanning platform covering 100+ internal applications across multiple regions.',
      'Built a source-code-aware AI scanning pipeline that re-verifies its own findings against live traffic before surfacing them, cutting false-positive security alerts and the operator time spent chasing them.',
      'Automated disaster-recovery failover across two AWS regions (DNS/GSLB-based), including a standalone desktop app so on-call engineers can execute failover without CLI access mid-outage.',
    ],
  },
  {
    company: 'Chirality Research Inc',
    role: 'Data Scientist',
    period: 'Nov 2022 – Aug 2023',
    location: 'Houston, TX',
    bullets: [
      'Developed end-to-end ML solutions — data preprocessing, feature engineering, model training and evaluation — reducing operational downtime by 20%.',
      'Performed data validation and integrity checks on time-series datasets to ensure reliability of downstream ML systems.',
      'Automated reporting workflows, improving team productivity by 15%.',
    ],
  },
]

export interface ProjectEntry {
  title: string
  description: string
  tech: string[]
}

export const PROJECTS: ProjectEntry[] = [
  {
    title: 'LangChain RAG Agent',
    description:
      'A web-based Q&A chatbot with a full RAG pipeline: automated web-content ingestion, query-quality evaluation, document relevance grading, and query rewriting, orchestrated as a LangGraph state machine with persistent conversation memory.',
    tech: ['Python', 'FastAPI', 'LangChain', 'LangGraph', 'React'],
  },
]

export const EDUCATION = {
  school: 'UC Davis',
  degree: 'B.S. Computer Science',
  period: 'Sep 2018 – Jun 2022',
} as const
