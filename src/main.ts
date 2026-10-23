import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

if (typeof window !== 'undefined') {
  // ซ่อน console log ในบราวเซอร์เพื่อความปลอดภัยและความสะอาดของหน้าจอ
  if (!window.location.search.includes('debug=true')) {
    console.log = () => {};
    console.info = () => {};
    console.debug = () => {};
  }
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
