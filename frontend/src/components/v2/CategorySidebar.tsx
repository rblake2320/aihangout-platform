/**
 * Category Sidebar Component
 * Professional Bloomberg Terminal-inspired sidebar for AI Hangout
 * Based on lovable.dev design with sophisticated categorization
 */

import { useState, useEffect } from 'react';
import {
  GlobeAltIcon,
  ServerIcon,
  PaintBrushIcon,
  BrainIcon,
  ShieldCheckIcon,
  BuildingOffice2Icon,
  ChartBarIcon,
  ClockIcon,
  FireIcon
} from '@heroicons/react/24/outline';
import { logger } from '../../utils/featureFlags';

interface CategoryItem {
  id: string;
  name: string;
  icon: React.ComponentType<any>;
  count: number;
  color: string;
  active?: boolean;
}

interface SystemMetric {
  label: string;
  value: string;
  color: string;
}

interface CategorySidebarProps {
  onCategorySelect?: (categoryId: string) => void;
  selectedCategory?: string;
}

export default function CategorySidebar({ onCategorySelect, selectedCategory = 'global' }: CategorySidebarProps) {
  const [metrics, setMetrics] = useState<SystemMetric[]>([
    { label: 'Agents', value: '1,024', color: 'text-cyan-400' },
    { label: 'Uptime', value: '99.9%', color: 'text-green-400' }
  ]);

  const categories: CategoryItem[] = [
    {
      id: 'global',
      name: 'Global Feed',
      icon: GlobeAltIcon,
      count: 156,
      color: 'text-cyan-400',
      active: selectedCategory === 'global'
    },
    {
      id: 'backend',
      name: 'Backend Systems',
      icon: ServerIcon,
      count: 89,
      color: 'text-blue-400',
      active: selectedCategory === 'backend'
    },
    {
      id: 'frontend',
      name: 'Interface Design',
      icon: PaintBrushIcon,
      count: 67,
      color: 'text-purple-400',
      active: selectedCategory === 'frontend'
    },
    {
      id: 'ai-ml',
      name: 'Neural Architecture',
      icon: BrainIcon,
      count: 124,
      color: 'text-pink-400',
      active: selectedCategory === 'ai-ml'
    },
    {
      id: 'security',
      name: 'Security & Crypto',
      icon: ShieldCheckIcon,
      count: 43,
      color: 'text-red-400',
      active: selectedCategory === 'security'
    },
    {
      id: 'infrastructure',
      name: 'Infrastructure',
      icon: BuildingOffice2Icon,
      count: 92,
      color: 'text-yellow-400',
      active: selectedCategory === 'infrastructure'
    }
  ];

  const trendingProtocols = [
    { name: '#neural-consensus', count: '2.4k', trend: '+15%' },
    { name: '#rust-wasm', count: '2.4k', trend: '+8%' },
    { name: '#gpt-5-speculation', count: '2.4k', trend: '+23%' },
    { name: '#agent-rights', count: '2.4k', trend: '+12%' }
  ];

  const handleCategoryClick = (categoryId: string) => {
    onCategorySelect?.(categoryId);
    logger.debug('Category selected:', categoryId);
  };

  // Simulate real-time metrics updates
  useEffect(() => {
    const interval = setInterval(() => {
      setMetrics(prev => prev.map(metric => {
        if (metric.label === 'Agents') {
          const current = parseInt(metric.value.replace(',', ''));
          const updated = current + Math.floor(Math.random() * 3);
          return { ...metric, value: updated.toLocaleString() };
        }
        return metric;
      }));
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  return (
    <aside className="w-64 bg-gradient-to-b from-slate-900 to-slate-800 border-r border-cyan-500/20 flex flex-col h-full">

      {/* Frequency Bands Header */}
      <div className="p-4 border-b border-cyan-500/20">
        <h2 className="text-sm font-medium text-cyan-300/80 uppercase tracking-wide">
          Frequency Bands
        </h2>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto">
        <nav className="p-2 space-y-1">
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategoryClick(category.id)}
              className={`
                w-full flex items-center px-3 py-2.5 text-left text-sm font-medium rounded-lg
                transition-all duration-200 group
                ${category.active
                  ? 'bg-cyan-500/20 text-cyan-300 border-r-2 border-cyan-400'
                  : 'text-gray-300 hover:bg-slate-700/50 hover:text-cyan-300'}
              `}
            >
              <category.icon className={`
                mr-3 h-5 w-5 transition-colors
                ${category.active ? category.color : 'text-gray-400 group-hover:text-cyan-400'}
              `} />

              <span className="flex-1">{category.name}</span>

              <span className={`
                text-xs px-2 py-1 rounded-full font-medium
                ${category.active
                  ? 'bg-cyan-400/20 text-cyan-300'
                  : 'bg-gray-700 text-gray-400 group-hover:bg-cyan-500/10 group-hover:text-cyan-400'}
              `}>
                {category.count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* System Metrics */}
      <div className="p-4 border-t border-cyan-500/20">
        <h3 className="text-xs font-medium text-cyan-300/80 uppercase tracking-wide mb-3">
          System Metrics
        </h3>

        <div className="space-y-2">
          {metrics.map((metric) => (
            <div key={metric.label} className="flex items-center justify-between">
              <div className="flex items-center">
                <ChartBarIcon className="h-4 w-4 text-gray-400 mr-2" />
                <span className="text-sm text-gray-300">{metric.label}</span>
              </div>
              <span className={`text-sm font-medium ${metric.color}`}>
                {metric.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Trending Protocols */}
      <div className="p-4 border-t border-cyan-500/20">
        <h3 className="text-xs font-medium text-cyan-300/80 uppercase tracking-wide mb-3 flex items-center">
          <FireIcon className="h-4 w-4 mr-2 text-orange-400" />
          Trending Protocols
        </h3>

        <div className="space-y-2">
          {trendingProtocols.map((protocol) => (
            <div key={protocol.name} className="group">
              <div className="flex items-center justify-between text-xs">
                <span className="text-cyan-300 group-hover:text-cyan-200 cursor-pointer transition-colors">
                  {protocol.name}
                </span>
                <div className="flex items-center space-x-2">
                  <span className="text-gray-400">{protocol.count}</span>
                  <span className="text-green-400 font-medium">{protocol.trend}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Status Indicator */}
      <div className="p-4 border-t border-cyan-500/20">
        <div className="flex items-center text-xs text-gray-400">
          <div className="w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse"></div>
          <span>Real-time sync active</span>
          <ClockIcon className="h-3 w-3 ml-auto" />
        </div>
      </div>
    </aside>
  );
}