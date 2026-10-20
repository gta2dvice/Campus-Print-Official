import React, { useEffect, useRef } from 'react';

export default function LazyFloatingLines({ props = {} }) {
  const containerRef = useRef(null);

  useEffect(() => {
    let dispose = () => {};

    const initEffect = async () => {
      try {
        // Dynamically import the mounting function and the Three.js library it depends on
        const { mountFloatingLines } = await import('../lib/floatingLines');

        if (containerRef.current) {
          dispose = mountFloatingLines(containerRef.current, props);
        }
      } catch (error) {
        console.error('Failed to load Three.js effect:', error);
      }
    };

    initEffect();

    return () => {
      if (dispose) dispose();
    };
  }, [props]);

  return (
    <div
      ref={containerRef}
      className="floating-lines-container"
      style={{ position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none' }}
    />
  );
}
