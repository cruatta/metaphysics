import {
  GraphQLSchema,
  GraphQLObjectType,
  visit,
  Kind,
  GraphQLInterfaceType,
  GraphQLUnionType,
  getNamedType,
  TypeInfo,
  visitWithTypeInfo,
  isLeafType,
  isNullableType,
} from "graphql"
import { transformSchema, Transform, Request } from "graphql-tools"
import {
  visitSchema,
  VisitSchemaKind,
  TypeVisitor,
} from "graphql-tools/dist/transforms/visitSchema"
import {
  createResolveType,
  fieldToFieldConfig,
} from "graphql-tools/dist/stitching/schemaRecreation"
import { GravityIDFields, InternalIDFields } from "./object_identification"

// TODO: These types should have their id fields renamed to internalID upstream,
//       but that requires us to do some transformation work _back_ on the v1
//       schema for it to remain backwards compatible, so we can do that at a
//       later time.
const KAWSTypes = ["MarketingCollection", "MarketingCollectionQuery"]
const ExchangeTypes = [
  "CommerceOrder",
  "CommercePartner",
  "CommerceUser",
  "CommerceLineItem",
  "CommerceFulfillment",
  "CommerceBuyOrder",
  "CommerceOffer",
  "CommerceOfferOrder",
]

// FIXME: ID fields shouldn't be nullable, so figure out what the deal is with
//        these.
const KnownTypesWithNullableIDFields = [
  "MarketingCollectionQuery",
  "FeaturedLinkItem",
  "HomePageModulesParams",
  "Image",
]

class IdRenamer implements Transform {
  private newSchema?: GraphQLSchema

  transformSchema(schema: GraphQLSchema): GraphQLSchema {
    // Keep a reference to all new interface types, as we'll need them to define
    // them on the new object types.
    const newInterfaces: { [name: string]: GraphQLInterfaceType } = {}

    const newSchema = visitSchema(schema, {
      [VisitSchemaKind.OBJECT_TYPE]: ((type: GraphQLObjectType<any, any>) => {
        const fields = type.getFields()
        const newFields = {}

        const resolveType = createResolveType((_name, type) => type)

        Object.keys(fields).forEach(fieldName => {
          const field = fields[fieldName]
          if (field.name === "id") {
            // Omit this id field entirely from the v2 schema, as it's a no-op
            if (type.name !== "SaleArtworkHighestBid") {
              if (
                isNullableType(field.type) &&
                !KnownTypesWithNullableIDFields.includes(type.name)
              ) {
                throw new Error(
                  `Do not add new nullable id fields (${type.name})`
                )
              } else {
                if (
                  field.description === GravityIDFields.id.description ||
                  type.name === "DoNotUseThisPartner"
                ) {
                  newFields["gravityID"] = {
                    ...fieldToFieldConfig(field, resolveType, true),
                    resolve: ({ id }) => id,
                    name: "gravityID",
                  }
                } else if (
                  field.description === InternalIDFields.id.description ||
                  KAWSTypes.includes(type.name) ||
                  ExchangeTypes.includes(type.name)
                ) {
                  newFields["internalID"] = {
                    ...fieldToFieldConfig(field, resolveType, true),
                    resolve: ({ id }) => id,
                    name: "internalID",
                  }
                } else {
                  throw new Error(`Do not add new id fields (${type.name})`)
                }
              }
            }
          } else if (field.name === "_id") {
            newFields["internalID"] = {
              ...fieldToFieldConfig(field, resolveType, true),
              resolve: ({ _id }) => _id,
              name: "internalID",
            }
          } else if (field.name === "__id") {
            newFields["id"] = {
              ...fieldToFieldConfig(field, resolveType, true),
              resolve: ({ __id }) => __id,
              name: "id",
            }
          } else {
            newFields[fieldName] = fieldToFieldConfig(field, resolveType, true)
          }
        })

        return new GraphQLObjectType({
          name: type.name,
          description: type.description,
          astNode: type.astNode,
          fields: newFields,
          extensionASTNodes: type.extensionASTNodes,
          isTypeOf: type.isTypeOf,
          interfaces: type
            .getInterfaces()
            .map(iface => newInterfaces[iface.name]),
        })
      }) as TypeVisitor,

      [VisitSchemaKind.INTERFACE_TYPE]: ((type: GraphQLInterfaceType) => {
        const fields = type.getFields()
        const newFields = {}

        const resolveType = createResolveType((_name, type) => type)

        Object.keys(fields).forEach(fieldName => {
          const field = fields[fieldName]
          if (field.name === "id") {
            if (
              field.description === GravityIDFields.id.description ||
              type.name === "DoNotUseThisPartner"
            ) {
              newFields["gravityID"] = {
                ...fieldToFieldConfig(field, resolveType, true),
                // resolve: ({ id }) => id,
                name: "gravityID",
              }
            } else if (
              field.description === InternalIDFields.id.description ||
              KAWSTypes.includes(type.name) ||
              ExchangeTypes.includes(type.name)
            ) {
              newFields["internalID"] = {
                ...fieldToFieldConfig(field, resolveType, true),
                // resolve: ({ id }) => id,
                name: "internalID",
              }
            } else {
              throw new Error(`Do not add new id fields (${type.name})`)
            }
          } else if (field.name === "_id") {
            newFields["internalID"] = {
              ...fieldToFieldConfig(field, resolveType, true),
              // resolve: ({ _id }) => _id,
              name: "internalID",
            }
          } else if (field.name === "__id") {
            newFields["id"] = {
              ...fieldToFieldConfig(field, resolveType, true),
              // resolve: source => {
              //   return source.__id
              // },
              name: "id",
            }
          } else {
            newFields[fieldName] = fieldToFieldConfig(field, resolveType, true)
          }
        })

        const newInterface = new GraphQLInterfaceType({
          name: type.name,
          description: type.description,
          astNode: type.astNode,
          fields: newFields,
          resolveType: type.resolveType,
          extensionASTNodes: type.extensionASTNodes,
        })
        newInterfaces[newInterface.name] = newInterface
        return newInterface
      }) as TypeVisitor,
    })

    if (this.newSchema) {
      throw new Error("UNEXPECTED!")
    }
    this.newSchema = newSchema

    return newSchema
  }

  public transformRequest(originalRequest: Request): Request {
    const typeInfo = new TypeInfo(this.newSchema!)

    const newDocument = visit(
      originalRequest.document,
      visitWithTypeInfo(typeInfo, {
        [Kind.FIELD]: {
          enter: node => {
            // This is the only field you can select on a unio type, which is
            // why union types don’t have a `getFields()` method. But seeing as
            // we don’t care about renaming that field anyways, might as well
            // just short-cut it here.
            if (node.name.value === "__typename") {
              return
            }

            const type = getTypeWithSelectableFields(typeInfo)
            const field = type.getFields()[node.name.value]

            if (
              node.name.value === "internalID" &&
              field.description === GravityIDFields._id.description
            ) {
              return {
                ...node,
                name: {
                  ...node.name,
                  value: "_id",
                },
              }
            } else if (
              node.name.value === "gravityID" ||
              node.name.value === "internalID"
            ) {
              return {
                ...node,
                name: {
                  ...node.name,
                  value: "id",
                },
              }
            } else if (node.name.value === "id") {
              return {
                ...node,
                name: {
                  ...node.name,
                  value: "__id",
                },
              }
            }
          },
        },
      })
    )

    return {
      ...originalRequest,
      document: newDocument,
    }
  }

  // FIXME: We need this nonetheless, otherwise aliasing fields breaks.
  //
  // TODO: If we want to make this generic for upstream usage, use `transformResult` instead of the inline resolver in transform schema
  // public transformResult(result: Result): Result {
  //   return result
  // }
}

// FIXME: Unsure why the `typeInfo` methods return `any`.
function getTypeWithSelectableFields(
  typeInfo: TypeInfo
): GraphQLObjectType<any, any> | GraphQLInterfaceType {
  const type = getNamedType(typeInfo.getType())
  return isLeafType(type) || type instanceof GraphQLUnionType
    ? getNamedType(typeInfo.getParentType())
    : type
}

export const transformToV2 = (schema: GraphQLSchema): GraphQLSchema => {
  return transformSchema(schema, [new IdRenamer()])
}
