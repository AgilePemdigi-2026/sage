# Logical data baseline

The repository baseline lists explicitly declared Prisma scalar attributes and relation fields with source evidence. The multiplicity is from the declaring entity to the field: a required scalar or relation is 1, an optional one is 0..1, and a list is 0..*. List notation does not require a nonempty list. An unresolved relation target is not emitted as a relationship.

This output is a declaration register, not a complete business logical ERD or a physical schema. It omits unsupported declarations and never infers cardinality from naming conventions. The ArchiMate Information Structure View remains a separate overview. Reanalyze existing snapshots to extract fields with the new analyzer.

- [Visual Paradigm: Conceptual, Logical and Physical Data Model](https://www.visual-paradigm.com/support/documents/vpuserguide/3563/3564/85378_conceptual,l.html)
- [Prisma ORM: Relations](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations)
- [The Open Group: TOGAF and ArchiMate](https://help.opengroup.org/hc/en-us/articles/32115987894930-How-the-ArchiMate-Language-and-the-TOGAF-Standard-Complement-Each-Other)
