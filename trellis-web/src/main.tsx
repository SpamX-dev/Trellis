import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import 'antd/dist/reset.css';
import './style.css';
import { Workspace } from './workspace';

createRoot(document.getElementById('root')!).render(<ConfigProvider locale={ruRU}><Workspace /></ConfigProvider>);
