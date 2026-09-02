import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installSecureApiFetch } from './api/fetch-security.ts'
import { FeedbackProvider } from './components/feedback/FeedbackProvider'

installSecureApiFetch()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FeedbackProvider>
      <App />
    </FeedbackProvider>
  </StrictMode>,
)
