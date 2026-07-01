// Vercel Web Analytics - Manual Integration for Static Sites
// This script should be loaded before your main app.js

(function() {
  'use strict';
  
  // Check if we're in a browser environment
  if (typeof window === 'undefined') return;
  
  // Detect environment - don't track in development
  function detectEnvironment() {
    var hostname = window.location.hostname;
    if (hostname === 'localhost' || 
        hostname === '127.0.0.1' ||
        hostname.indexOf('.local') > -1) {
      return 'development';
    }
    return 'production';
  }
  
  var mode = detectEnvironment();
  
  // Set the mode globally
  window.vam = mode;
  
  // Initialize the analytics queue
  if (!window.va) {
    window.va = function va() {
      (window.vaq = window.vaq || []).push(arguments);
    };
  }
  
  // Only inject the script in production
  if (mode === 'production') {
    var script = document.createElement('script');
    script.defer = true;
    script.src = '/_vercel/insights/script.js';
    
    script.onerror = function() {
      console.warn('[Vercel Web Analytics] Failed to load. Make sure Web Analytics is enabled in your Vercel project settings.');
    };
    
    if (document.head) {
      document.head.appendChild(script);
    } else {
      // If head doesn't exist yet, wait for DOM to be ready
      document.addEventListener('DOMContentLoaded', function() {
        document.head.appendChild(script);
      });
    }
  } else {
    console.log('[Vercel Web Analytics] Running in development mode - analytics tracking is disabled');
  }
})();
