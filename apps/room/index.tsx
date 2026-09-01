import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { AuthGate } from './ui/AuthGate';
import { RoomApp } from './ui/RoomApp';
import { LandingApp } from './ui/LandingApp';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const roomMatch = window.location.pathname.match(/^\/r\/([A-Za-z0-9]{6,16})\/?$/);

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthGate>
        {roomMatch ? <RoomApp roomId={roomMatch[1]} /> : <LandingApp />}
      </AuthGate>
    </ThemeProvider>
  </React.StrictMode>
);
