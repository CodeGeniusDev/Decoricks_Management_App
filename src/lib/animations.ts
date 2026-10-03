import { gsap } from 'gsap'

/**
 * Animation utilities using GSAP
 * All animations are subtle and professional, fitting the Liquid Glass design
 */

// Common animation configurations
export const animations = {
  // Fade in with slight slide up
  fadeInUp: (element: Element | Element[], duration = 0.4, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration, delay, ease: 'power2.out' }
    )
  },

  // Fade in with slight slide down
  fadeInDown: (element: Element | Element[], duration = 0.4, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, y: -20 },
      { opacity: 1, y: 0, duration, delay, ease: 'power2.out' }
    )
  },

  // Fade in with slight slide from left
  fadeInLeft: (element: Element | Element[], duration = 0.4, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, x: -20 },
      { opacity: 1, x: 0, duration, delay, ease: 'power2.out' }
    )
  },

  // Fade in with slight slide from right
  fadeInRight: (element: Element | Element[], duration = 0.4, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, x: 20 },
      { opacity: 1, x: 0, duration, delay, ease: 'power2.out' }
    )
  },

  // Simple fade in
  fadeIn: (element: Element | Element[], duration = 0.3, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0 },
      { opacity: 1, duration, delay, ease: 'power2.out' }
    )
  },

  // Scale in with fade
  scaleIn: (element: Element | Element[], duration = 0.4, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, scale: 0.9 },
      { opacity: 1, scale: 1, duration, delay, ease: 'back.out(1.7)' }
    )
  },

  // Staggered fade in for lists
  staggerFadeIn: (elements: Element | Element[], duration = 0.3, stagger = 0.1) => {
    return gsap.fromTo(
      elements,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration, stagger, ease: 'power2.out' }
    )
  },

  // Button hover animation
  buttonHover: (element: Element) => {
    return gsap.to(element, { scale: 1.05, duration: 0.2, ease: 'power2.out' })
  },

  buttonHoverOut: (element: Element) => {
    return gsap.to(element, { scale: 1, duration: 0.2, ease: 'power2.out' })
  },

  // Card hover animation
  cardHover: (element: Element) => {
    return gsap.to(element, {
      y: -4,
      boxShadow: '0 20px 25px -5px rgba(10, 9, 8, 0.15), 0 10px 10px -5px rgba(10, 9, 8, 0.08)',
      duration: 0.3,
      ease: 'power2.out',
    })
  },

  cardHoverOut: (element: Element) => {
    return gsap.to(element, {
      y: 0,
      boxShadow: '0 4px 6px -1px rgba(10, 9, 8, 0.1), 0 2px 4px -1px rgba(10, 9, 8, 0.06)',
      duration: 0.3,
      ease: 'power2.out',
    })
  },

  // Modal enter animation
  modalEnter: (backdrop: Element, content: Element) => {
    const tl = gsap.timeline()

    tl.fromTo(
      backdrop,
      { opacity: 0 },
      { opacity: 1, duration: 0.3, ease: 'power2.out' }
    ).fromTo(
      content,
      { opacity: 0, scale: 0.9, y: 20 },
      { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.7)' },
      '-=0.2'
    )

    return tl
  },

  // Modal exit animation
  modalExit: (backdrop: Element, content: Element) => {
    const tl = gsap.timeline()

    tl.to(content, {
      opacity: 0,
      scale: 0.9,
      y: 20,
      duration: 0.3,
      ease: 'power2.in',
    }).to(backdrop, { opacity: 0, duration: 0.3, ease: 'power2.in' }, '-=0.2')

    return tl
  },

  // Toast enter animation
  toastEnter: (element: Element) => {
    return gsap.fromTo(
      element,
      { opacity: 0, x: 100, y: -20 },
      { opacity: 1, x: 0, y: 0, duration: 0.4, ease: 'back.out(1.7)' }
    )
  },

  // Toast exit animation
  toastExit: (element: Element) => {
    return gsap.to(element, {
      opacity: 0,
      x: 100,
      duration: 0.3,
      ease: 'power2.in',
    })
  },

  // Skeleton loading animation
  skeletonPulse: (element: Element) => {
    return gsap.to(element, {
      opacity: 0.5,
      duration: 0.8,
      repeat: -1,
      yoyo: true,
      ease: 'power1.inOut',
    })
  },

  // Page transition
  pageEnter: (element: Element) => {
    return gsap.fromTo(
      element,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }
    )
  },

  // Sidebar toggle animation
  sidebarCollapse: (element: Element) => {
    return gsap.to(element, { width: 64, duration: 0.3, ease: 'power2.inOut' })
  },

  sidebarExpand: (element: Element) => {
    return gsap.to(element, { width: 256, duration: 0.3, ease: 'power2.inOut' })
  },

  // Tab switch animation
  tabSwitch: (oldContent: Element, newContent: Element) => {
    const tl = gsap.timeline()

    tl.to(oldContent, {
      opacity: 0,
      y: -10,
      duration: 0.2,
      ease: 'power2.in',
    }).fromTo(
      newContent,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out' },
      '-=0.1'
    )

    return tl
  },

  // Tooltip animation
  tooltipEnter: (element: Element) => {
    return gsap.fromTo(
      element,
      { opacity: 0, scale: 0.8 },
      { opacity: 1, scale: 1, duration: 0.2, ease: 'back.out(1.7)' }
    )
  },

  tooltipExit: (element: Element) => {
    return gsap.to(element, {
      opacity: 0,
      scale: 0.8,
      duration: 0.15,
      ease: 'power2.in',
    })
  },

  // Table row hover
  tableRowHover: (element: Element) => {
    return gsap.to(element, {
      backgroundColor: 'rgba(43, 43, 43, 0.05)',
      duration: 0.2,
      ease: 'power2.out',
    })
  },

  tableRowHoverOut: (element: Element) => {
    return gsap.to(element, {
      backgroundColor: 'transparent',
      duration: 0.2,
      ease: 'power2.out',
    })
  },

  // Badge enter animation
  badgeEnter: (element: Element, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, scale: 0.8 },
      { opacity: 1, scale: 1, duration: 0.3, delay, ease: 'back.out(1.7)' }
    )
  },

  // Badge hover animation
  badgeHover: (element: Element) => {
    return gsap.to(element, {
      scale: 1.1,
      duration: 0.2,
      ease: 'power2.out',
    })
  },

  badgeHoverOut: (element: Element) => {
    return gsap.to(element, {
      scale: 1,
      duration: 0.2,
      ease: 'power2.out',
    })
  },

  // Input focus animation
  inputFocus: (element: Element) => {
    return gsap.to(element, {
      scale: 1.02,
      duration: 0.2,
      ease: 'power2.out',
    })
  },

  inputFocusOut: (element: Element) => {
    return gsap.to(element, {
      scale: 1,
      duration: 0.2,
      ease: 'power2.out',
    })
  },

  // Tabs active indicator animation
  tabIndicator: (element: Element, active: boolean) => {
    if (active) {
      return gsap.fromTo(
        element,
        { scaleX: 0, opacity: 0 },
        { scaleX: 1, opacity: 1, duration: 0.3, ease: 'power2.out' }
      )
    }
    return gsap.to(element, {
      scaleX: 0,
      opacity: 0,
      duration: 0.2,
      ease: 'power2.in',
    })
  },

  // Empty/Error state icon animation
  stateIconEnter: (element: Element, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, scale: 0.5, y: 20 },
      { opacity: 1, scale: 1, y: 0, duration: 0.5, delay, ease: 'back.out(1.7)' }
    )
  },

  // Header enter animation
  headerEnter: (element: Element) => {
    return gsap.fromTo(
      element,
      { opacity: 0, y: -20 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }
    )
  },

  // Mobile nav item stagger
  navItemStagger: (element: Element, delay = 0) => {
    return gsap.fromTo(
      element,
      { opacity: 0, x: -20 },
      { opacity: 1, x: 0, duration: 0.3, delay, ease: 'power2.out' }
    )
  },

  // Content block stagger for page sections
  contentBlockStagger: (elements: Element | Element[], duration = 0.3, stagger = 0.1) => {
    return gsap.fromTo(
      elements,
      { opacity: 0, y: 15 },
      { opacity: 1, y: 0, duration, stagger, ease: 'power2.out' }
    )
  },
}

// Cleanup all animations on an element
export const cleanupAnimations = (element: Element) => {
  gsap.killTweensOf(element)
}
