//! Actual service adapters over counted offline providers.
use super::*;

#[test]
fn pipeline_embedder_shares_identity_cache_cancellation_and_close() {
    let (service, calls) = service(3, 3, Duration::ZERO, None);
    let service = Arc::new(service);
    let provider = service.pipeline_embedder();
    assert_eq!(
        serde_json::to_value(provider.identity()).unwrap(),
        serde_json::to_value(space(3)).unwrap()
    );
    assert_eq!(provider.model_selection().model.as_deref(), Some("fixture"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let texts = vec!["same passage".to_owned()];
    let expected = service
        .embed(&texts, EmbedKind::Passage, &identity(3), &Cancel::never())
        .unwrap();
    assert_eq!(
        provider
            .embed(&texts, EmbedKind::Passage, &Cancel::never())
            .unwrap(),
        expected
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    provider
        .embed(&texts, EmbedKind::Query, &Cancel::never())
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        provider.embed(&texts, EmbedKind::Query, &cancel),
        Err(EmbedError::Cancelled(_))
    ));
    service.close();
    assert!(matches!(
        provider.embed(&texts, EmbedKind::Query, &Cancel::never()),
        Err(EmbedError::Unavailable)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
#[test]
fn pipeline_embedder_keeps_the_service_vector_validation() {
    let (service, _) = service(3, 2, Duration::ZERO, None);
    let provider = Arc::new(service).pipeline_embedder();
    assert!(matches!(
        provider.embed(&["wrong width".into()], EmbedKind::Query, &Cancel::never()),
        Err(EmbedError::DimensionMismatch {
            expected: 3,
            actual: 2
        })
    ));
}
#[test]
fn pipeline_reranker_is_absent_when_no_provider_is_configured() {
    let (service, _) = service(3, 3, Duration::ZERO, None);
    assert!(Arc::new(service).pipeline_reranker().is_none());
}
#[test]
fn pipeline_reranker_keeps_real_results_cancellation_and_close() {
    let service = Arc::new(
        Service::new(
            Box::new(CountingProvider {
                identity: space(3),
                calls: Arc::new(AtomicUsize::new(0)),
                width: 3,
                delay: Duration::ZERO,
            }),
            Some(Box::new(FloatIndexReranker)),
            identity(3),
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    let provider = service.pipeline_reranker().unwrap();
    assert!(!provider.empty_result_is_valid());
    assert_eq!(provider.model_selections().len(), 1);
    let hits = provider
        .rerank("query", &["one".into(), "two".into()], 1, &Cancel::never())
        .unwrap();
    assert_eq!(hits[0].index.as_f64(), Some(1.));
    assert_eq!(hits[0].score.as_f64(), Some(0.75));
    assert!(matches!(
        provider.rerank("query", &["one".into()], 1, &Cancel::never()),
        Err(plur1bus_engine::embedding::RerankError::InvalidResponse)
    ));
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        provider.rerank("query", &["one".into()], 1, &cancel),
        Err(plur1bus_engine::embedding::RerankError::Cancelled(_))
    ));
    service.close();
    assert!(matches!(
        provider.rerank("query", &["one".into()], 1, &Cancel::never()),
        Err(plur1bus_engine::embedding::RerankError::Unavailable)
    ));
}

#[test]
fn pipeline_invalidation_reaches_the_same_owned_provider() {
    struct InvalidatedProvider {
        space: VectorSpaceIdentity,
        invalidations: Arc<AtomicUsize>,
    }
    impl EmbeddingProvider for InvalidatedProvider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.space
        }
        fn embed(
            &self,
            _: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            Err(EmbedError::Unavailable)
        }
        fn invalidate_egress(&self) {
            self.invalidations.fetch_add(1, Ordering::SeqCst);
        }
    }
    let invalidations = Arc::new(AtomicUsize::new(0));
    let service = Arc::new(
        Service::new(
            Box::new(InvalidatedProvider {
                space: space(3),
                invalidations: invalidations.clone(),
            }),
            None,
            identity(3),
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    let provider = service.pipeline_embedder();
    provider.invalidate_egress();
    assert_eq!(invalidations.load(Ordering::SeqCst), 1);
    service.invalidate_egress();
    assert_eq!(invalidations.load(Ordering::SeqCst), 2);
}
