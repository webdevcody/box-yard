import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "./App"
import { ApiError } from "./lib/api"
import { installPageGuards } from "./lib/resume"
import "./styles.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live updates arrive over SSE, so data stays fresh without refetching.
      staleTime: 60_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 3,
    },
    mutations: { retry: 0 },
  },
})

// Phones: the document scroll goes back after the keyboard closes and when the page comes back.
installPageGuards()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
