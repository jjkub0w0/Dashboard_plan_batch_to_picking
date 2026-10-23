import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/dashboard/dashboard').then(m => m.DashboardComponent),
    title: 'Dashboard - Plan Batch to Picking'
  },
  {
    path: 'so-batches',
    loadComponent: () => import('./pages/so-batches/so-batches').then(m => m.SoBatchesComponent),
    title: 'รายละเอียดเลข Batch ตาม SO - Plan Batch to Picking'
  },
  {
    path: 'out-dhl',
    loadComponent: () => import('./pages/out-dhl/out-dhl').then(m => m.OutDhlComponent),
    title: 'ข้อมูลนอกเหนือจากระบบ TMS - Plan Batch to Picking'
  },
  {
    path: 'non-tms',
    loadComponent: () => import('./pages/out-dhl/out-dhl').then(m => m.OutDhlComponent),
    title: 'ข้อมูลนอกเหนือจากระบบ TMS - Plan Batch to Picking'
  },
  {
    path: 'trends',
    loadComponent: () => import('./pages/trends/trends').then(m => m.TrendsComponent),
    title: 'กราฟแนวโน้มความถูกต้องของ Batch - Plan Batch to Picking'
  },
  {
    path: '**',
    redirectTo: ''
  }
];
