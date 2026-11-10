import { render } from 'preact';
import { App } from './App.tsx';
import { registerServiceWorker } from './lib/serviceWorker.ts';
import './styles.css';

render(<App />, document.getElementById('app')!);

void registerServiceWorker();
