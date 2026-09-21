import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { queryClient } from './api/queries';
import './index.css';
import { router } from './routes/router';

/** The mount point declared in `index.html`. */
const ROOT_ELEMENT_ID = 'root';
const MISSING_ROOT_MESSAGE = `index.html is missing #${ROOT_ELEMENT_ID}`;

const rootElement = document.getElementById(ROOT_ELEMENT_ID);

if (rootElement === null) {
  throw new Error(MISSING_ROOT_MESSAGE);
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
