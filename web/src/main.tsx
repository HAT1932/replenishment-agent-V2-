/**
 * main.tsx — 前端入口
 *  - StrictMode + ToastProvider（全局提示）
 *  - 样式由 index.html 的四个 <link> 引入（tokens → base → components → features）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from './components/Toast';
import { App } from './app/App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 容器');
}

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
