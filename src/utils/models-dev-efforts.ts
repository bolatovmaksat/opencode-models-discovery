type Efforts = readonly string[] | undefined
interface EffortIndex {
  routes: Map<string, Efforts>
  // A null route means more than one model has this short name.
  shortNames: Map<string, string | null>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function namedEfforts(options: unknown): Efforts {
  if (!Array.isArray(options)) return
  for (const option of options) {
    if (option?.type !== 'effort' || !Array.isArray(option.values)) continue
    const rawNames: string[] = option.values.flatMap((value: unknown) =>
      typeof value === 'string' && value.trim() ? [value.trim()] : [],
    )
    // An explicit empty or default-only declaration takes precedence over the supplement.
    if (rawNames.length || !option.values.length) {
      return [...new Set(rawNames.filter(name => name !== 'default'))]
    }
  }
}

export function indexEfforts(data: unknown, layout: 'flat' | 'providers' | 'mirror'): EffortIndex | undefined {
  if (!isObject(data)) return
  const routes = new Map<string, Efforts>()
  const shortNames = new Map<string, string | null>()
  const mirror = layout === 'mirror'

  function add(key: string, row: Record<string, unknown>, provider?: string) {
    // Public keys identify provider routes, even when a gateway key contains slashes.
    // Mirrors use the same explicit ID projection as their ordinary model metadata.
    const id = mirror && typeof row.id === 'string' && row.id ? row.id : key
    const route = provider && !(mirror && id.includes('/')) ? provider + '/' + id : id
    if (!id.trim() || (!mirror && !route.includes('/'))) return

    const efforts = namedEfforts(row.reasoning_options)
    if (routes.has(route)) {
      const previous = routes.get(route)
      if (previous?.length !== efforts?.length || previous?.some(name => !efforts?.includes(name))) {
        routes.set(route, []) // Conflicting aliases cannot establish this route's efforts.
      }
      return
    }
    routes.set(route, efforts)
    const shortName = route.slice(route.indexOf('/') + 1)
    if (!shortName.includes('/')) shortNames.set(shortName, shortNames.has(shortName) ? null : route)
  }

  for (const [key, value] of Object.entries(data)) {
    if (!isObject(value)) continue
    if (layout === 'providers' || (mirror && !key.includes('/') && isObject(value.models))) {
      if (!key.trim() || !isObject(value.models)) continue
      for (const [id, row] of Object.entries(value.models)) {
        if (isObject(row)) add(id, row, key)
      }
    } else {
      add(key, value)
    }
  }
  if (routes.size) return { routes, shortNames }
}

/**
 * Resolves declared reasoning efforts for a discovered model id.
 *
 * `canonicalRoute` maps a discovered id to the models.dev route its metadata
 * resolves to. It is only consulted when no index knows the requested route, so
 * a route that models.dev declares itself stays authoritative, including one
 * that declares reasoning without named efforts. This lets gateway aliases such
 * as `chiyicn/gpt-6.2-sol` reuse the efforts declared for `openai/gpt-6.2-sol`
 * instead of falling back to the generic low/medium/high tiers.
 */
export function matchModelsDevEfforts(
  primary?: EffortIndex,
  supplement?: EffortIndex,
  canonicalRoute?: (modelID: string) => string | undefined,
): (modelID: string, providerID?: string) => Efforts {
  const effortsFor = (route: string): Efforts => {
    const efforts = primary?.routes.get(route) ?? supplement?.routes.get(route)
    return efforts?.length ? efforts : undefined
  }
  const known = (route: string): boolean =>
    Boolean(primary?.routes.has(route) || supplement?.routes.has(route))

  return (modelID, providerID) => {
    if (providerID) {
      const providerRoute = `${providerID.toLowerCase()}/${modelID}`
      if (known(providerRoute)) return effortsFor(providerRoute)
    }

    if (modelID.includes('/')) {
      if (known(modelID)) return effortsFor(modelID)
    } else if (primary) {
      // A missing primary index cannot establish a unique short name.
      const shortRoute = primary.routes.has(modelID) ? modelID : primary.shortNames.get(modelID)
      if (shortRoute) return effortsFor(shortRoute)
      if (shortRoute === null) return // More than one model shares this short name.
      const supplementRoute = supplement?.shortNames.get(modelID)
      if (supplementRoute) return effortsFor(supplementRoute)
    }

    if (!canonicalRoute) return
    const canonical = canonicalRoute(modelID)
    if (!canonical || canonical === modelID) return
    return effortsFor(canonical)
  }
}
